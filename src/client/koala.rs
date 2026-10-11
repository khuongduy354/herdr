use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;

use super::ClientLoopEvent;

const MAX_VIEW_BYTES: usize = 1024 * 1024;

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub(super) struct KoalaView {
    pub server: String,
    pub fresh: bool,
    pub message: String,
    pub groups: Vec<KoalaGroup>,
    pub sound: bool,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub(super) struct KoalaGroup {
    pub id: Option<String>,
    pub name: String,
    pub collapsed: bool,
    pub tasks: Vec<KoalaTask>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub(super) struct KoalaTask {
    pub id: String,
    pub title: String,
    pub activity: String,
    pub key: String,
    pub stale: bool,
    pub tracked: bool,
}

/// Owns the adapter process; all pipe I/O stays off the client event loop.
pub(super) struct Runtime {
    child: Child,
    commands: Option<SyncSender<Value>>,
}

impl Runtime {
    pub fn start(
        event_tx: tokio::sync::mpsc::Sender<ClientLoopEvent>,
    ) -> Result<Option<Self>, String> {
        let Some(path) = std::env::var_os("HERDR_KOALA_ADAPTER") else {
            return Ok(None);
        };
        if path.is_empty() {
            return Err("koala adapter path is empty.".into());
        }
        let binary = std::env::current_exe()
            .map_err(|_| "couldn't locate the herdr executable.".to_string())?;
        let child = Command::new("node")
            .arg(path)
            .env("HERDR_BINARY", binary)
            .env("HERDR_KOALA_SOCKET", crate::api::socket_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "couldn't start the koala adapter.".to_string())?;
        let (commands, receiver) = mpsc::sync_channel::<Value>(32);
        // Establish ownership before any fallible setup so errors reap the child.
        let mut runtime = Self {
            child,
            commands: Some(commands),
        };
        let mut stdin = runtime
            .child
            .stdin
            .take()
            .ok_or("couldn't open koala adapter input.")?;
        let stdout = runtime
            .child
            .stdout
            .take()
            .ok_or("couldn't open koala adapter output.")?;
        let writer_events = event_tx.clone();
        thread::Builder::new()
            .name("koala-adapter-writer".into())
            .spawn(move || {
                for command in receiver {
                    if serde_json::to_writer(&mut stdin, &command).is_err()
                        || stdin.write_all(b"\n").is_err()
                        || stdin.flush().is_err()
                    {
                        let _ = writer_events.blocking_send(ClientLoopEvent::KoalaDisconnected);
                        break;
                    }
                }
                // Dropping stdin gives the worker an EOF to stop sound and exit.
            })
            .map_err(|_| "couldn't start koala adapter input.".to_string())?;
        thread::Builder::new()
            .name("koala-adapter-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                while let Ok(Some(view)) = read_view(&mut reader) {
                    if event_tx
                        .blocking_send(ClientLoopEvent::Koala(view))
                        .is_err()
                    {
                        return;
                    }
                }
                let _ = event_tx.blocking_send(ClientLoopEvent::KoalaDisconnected);
            })
            .map_err(|_| "couldn't start koala adapter output.".to_string())?;
        Ok(Some(runtime))
    }

    pub fn send(&self, command: Value) -> Result<(), String> {
        self.commands
            .as_ref()
            .ok_or_else(|| "koala adapter is closed.".to_string())?
            .try_send(command)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => "koala adapter is busy.".into(),
                mpsc::TrySendError::Disconnected(_) => "koala adapter is disconnected.".into(),
            })
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(commands) = self.commands.take() {
            let _ = commands.try_send(serde_json::json!({ "type": "shutdown" }));
        }
        let deadline = Instant::now() + Duration::from_millis(200);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                _ => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Bounds memory before deserialization, including streams with no newline.
fn read_view(reader: &mut impl BufRead) -> io::Result<Option<KoalaView>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete koala view.",
                ))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(available.len());
        if line.len() + length > MAX_VIEW_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "koala view exceeds size limit.",
            ));
        }
        line.extend_from_slice(&available[..length]);
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            return serde_json::from_slice(&line)
                .map(Some)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid koala view."));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn views_preserve_group_identity_and_task_attention() {
        let data = br#"{"server":"https://example.test","fresh":true,"groups":[{"id":"g1","name":"work","tasks":[{"id":"t1","title":"fix","activity":"waiting","key":"1","tracked":true}]}]}
{}
"#;
        let mut reader = BufReader::with_capacity(7, &data[..]);
        let view = read_view(&mut reader).unwrap().unwrap();
        assert!(view.fresh);
        assert_eq!(view.groups[0].id.as_deref(), Some("g1"));
        assert_eq!(view.groups[0].tasks[0].activity, "waiting");
        assert!(view.groups[0].tasks[0].tracked);
        assert!(!view.sound);
        assert!(read_view(&mut reader).unwrap().unwrap().groups.is_empty());
        assert!(read_view(&mut reader).unwrap().is_none());
    }

    #[test]
    fn malformed_and_truncated_views_fail_closed() {
        for input in [b"{bad}\n".as_slice(), b"{\"fresh\":\"yes\"}\n", b"{}"] {
            assert!(read_view(&mut BufReader::new(input)).is_err());
        }
    }

    #[test]
    fn oversized_unterminated_stream_is_rejected_before_consuming_everything() {
        let data = vec![b' '; MAX_VIEW_BYTES * 2];
        let mut reader = io::Cursor::new(data);
        assert_eq!(
            read_view(&mut reader).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(reader.position() < MAX_VIEW_BYTES as u64);
    }
}
