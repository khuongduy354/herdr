use super::*;
use crate::client::koala::KoalaView;
use crossterm::event::{KeyCode, KeyModifiers};
use serde_json::json;

#[derive(Default)]
pub(super) struct KoalaPanel {
    pub view: KoalaView,
    pub selected: Option<String>,
    pub focused: bool,
    pub prompt: Option<(Option<String>, String)>,
}

impl KoalaPanel {
    fn visible_ids(&self) -> Vec<String> {
        self.view
            .groups
            .iter()
            .filter(|group| !group.collapsed)
            .flat_map(|group| group.tasks.iter().map(|task| task.id.clone()))
            .collect()
    }

    fn reveal_selected(&self, body_height: u16, row_gap: u16, scroll: &mut usize) {
        if body_height == 0 {
            return;
        }
        let mut count = 0;
        let mut target = None;
        for group in &self.view.groups {
            let header = count;
            count += 1;
            for task in &group.tasks {
                if self.selected.as_ref() == Some(&task.id) {
                    target = Some(if group.collapsed { header } else { count });
                }
                if !group.collapsed {
                    count += 1;
                }
            }
        }
        if let Some(target) = target {
            let mut gaps = vec![row_gap; count];
            if let Some(last) = gaps.last_mut() {
                *last = 0;
            }
            *scroll = super::scroll::list_scroll_start_to_reveal(
                &vec![1; count],
                &gaps,
                body_height,
                *scroll,
                target,
            );
        }
    }
}

impl ClientShellState {
    pub(in crate::client) fn receive_koala(&mut self, view: KoalaView) {
        let panel = self.koala.get_or_insert_with(Default::default);
        panel.view = view;
        if !panel
            .view
            .groups
            .iter()
            .flat_map(|group| &group.tasks)
            .any(|task| Some(&task.id) == panel.selected.as_ref())
        {
            panel.selected = panel.visible_ids().first().cloned();
        }
    }

    pub(crate) fn koala_notice(&mut self, message: String) {
        let panel = self.koala.get_or_insert_with(Default::default);
        panel.view.message = message;
    }

    pub(crate) fn koala_disconnected(&mut self) {
        if let Some(panel) = &mut self.koala {
            panel.view.fresh = false;
            for task in panel
                .view
                .groups
                .iter_mut()
                .flat_map(|group| &mut group.tasks)
            {
                task.stale = true;
            }
            if panel.view.message.is_empty() {
                panel.view.message = "adapter stopped; restart Duy’s Koala Herd.".into();
            }
        }
    }

    pub(super) fn open_koala(&mut self, id: String, outcome: &mut ClientShellInput) {
        if !self.active_endpoint_id.is_local() {
            self.koala_notice("select a local Herdr workspace before opening Koala.".into());
        } else {
            let workspace = self
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.focused_workspace_id.clone());
            outcome.actions.push(ClientShellAction::Koala(
                json!({"type":"open", "id":id, "workspace":workspace}),
            ));
            if let Some(panel) = &mut self.koala {
                panel.focused = false;
                panel.selected = Some(id);
            }
        }
        outcome.repaint = true;
    }

    pub(super) fn koala_index(&self, index: usize) -> Option<String> {
        self.koala.as_ref()?.visible_ids().get(index).cloned()
    }

    pub(super) fn koala_text(&mut self, text: &str, outcome: &mut ClientShellInput) -> bool {
        let Some(panel) = self.koala.as_mut().filter(|panel| panel.focused) else {
            return false;
        };
        if let Some((_, name)) = &mut panel.prompt {
            let remaining = 80usize.saturating_sub(name.chars().count());
            name.extend(text.chars().filter(|ch| !ch.is_control()).take(remaining));
            outcome.repaint = true;
        }
        true
    }

    pub(super) fn koala_key(
        &mut self,
        key: &crate::input::TerminalKey,
        outcome: &mut ClientShellInput,
    ) -> bool {
        let Some(panel) = &mut self.koala else {
            return false;
        };
        if key.code == KeyCode::F(8) && key.modifiers.is_empty() {
            panel.focused = !panel.focused;
            if panel.focused {
                panel.reveal_selected(
                    self.hits.agent_body.height,
                    self.config.agents.row_gap,
                    &mut self.agent_scroll,
                );
            }
            self.sidebar_collapsed = false;
            outcome.repaint = true;
            outcome.resize = true;
            return true;
        }
        if !panel.focused {
            return false;
        }
        outcome.repaint = true;
        // Modified terminal shortcuts must not accidentally mutate groups or sound selection.
        if !key.modifiers.difference(KeyModifiers::SHIFT).is_empty() {
            return true;
        }
        if let Some((group, name)) = &mut panel.prompt {
            match key.code {
                KeyCode::Esc => panel.prompt = None,
                KeyCode::Backspace => {
                    name.pop();
                }
                KeyCode::Char(ch)
                    if !ch.is_control()
                        && key.modifiers.difference(KeyModifiers::SHIFT).is_empty() =>
                {
                    if name.chars().count() < 80 {
                        name.push(ch);
                    }
                }
                KeyCode::Enter => {
                    outcome.actions.push(ClientShellAction::Koala(json!({
                        "type":if group.is_some() { "rename" } else { "create" }, "group":group, "name":name
                    })));
                    panel.prompt = None;
                }
                _ => {}
            }
            return true;
        }
        let ids = panel.visible_ids();
        let index = ids
            .iter()
            .position(|id| Some(id) == panel.selected.as_ref());
        let group = panel.view.groups.iter().find(|group| {
            group
                .tasks
                .iter()
                .any(|task| Some(&task.id) == panel.selected.as_ref())
        });
        let group_id = group.and_then(|group| group.id.clone());
        let mut command = None;
        match key.code {
            KeyCode::Esc => panel.focused = false,
            KeyCode::Up | KeyCode::Down => {
                let next = if key.code == KeyCode::Up {
                    index.unwrap_or(0).saturating_sub(1)
                } else {
                    index
                        .map_or(0, |index| index + 1)
                        .min(ids.len().saturating_sub(1))
                };
                if let Some(id) = ids.get(next) {
                    panel.selected = Some(id.clone());
                }
                panel.reveal_selected(
                    self.hits.agent_body.height,
                    self.config.agents.row_gap,
                    &mut self.agent_scroll,
                );
            }
            KeyCode::Enter => {
                if let Some(id) = panel.selected.clone() {
                    self.open_koala(id, outcome);
                }
                return true;
            }
            KeyCode::Char('g') => panel.prompt = Some((None, String::new())),
            KeyCode::Char('r') if group_id.is_some() => {
                panel.prompt = Some((group_id, group.map(|g| g.name.clone()).unwrap_or_default()))
            }
            KeyCode::Char('c') if group_id.is_some() => {
                command = Some(json!({"type":"collapse","group":group_id}))
            }
            KeyCode::Char('s') => command = Some(json!({"type":"sound"})),
            KeyCode::Char(' ') if panel.selected.is_some() => {
                command = Some(json!({"type":"track","id":panel.selected}))
            }
            KeyCode::Char('m') if panel.selected.is_some() => {
                let current = panel
                    .view
                    .groups
                    .iter()
                    .position(|group| group.id == group_id)
                    .unwrap_or(0);
                let next = panel
                    .view
                    .groups
                    .get((current + 1) % panel.view.groups.len());
                command = Some(
                    json!({"type":"move","id":panel.selected,"group":next.and_then(|g| g.id.clone())}),
                );
            }
            _ => {}
        }
        if let Some(command) = command {
            outcome.actions.push(ClientShellAction::Koala(command));
        }
        true
    }
}

pub(super) fn render(
    buffer: &mut Buffer,
    area: Rect,
    panel: &KoalaPanel,
    config: &ClientShellConfig,
    scroll: &mut usize,
    hits: &mut ShellHitMap,
) {
    use super::render::put_text;
    if !super::agent_sidebar::render_agent_panel_header(
        buffer,
        area,
        Some("Duy’s Koala Herd"),
        config,
        hits,
    ) {
        return;
    }
    hits.agent_sort_toggle = Rect::default();
    let color = config.palette.overlay0;
    if area.height > 2 {
        put_text(
            buffer,
            area.x,
            area.y + 2,
            area.width,
            &format!(
                "{} {}",
                if panel.view.fresh { "●" } else { "?" },
                panel.view.message
            ),
            Style::default().fg(color),
        );
    }
    let mut task_index = 0;
    let rows = panel
        .view
        .groups
        .iter()
        .flat_map(|group| {
            let header = (true, group.id.clone(), group.name.clone(), false, false);
            let mut rows = vec![header];
            if !group.collapsed {
                rows.extend(group.tasks.iter().map(|task| {
                    task_index += 1;
                    (
                        false,
                        Some(task.id.clone()),
                        format!(
                            "{} {} {} {}",
                            task_index,
                            if task.tracked { "[x]" } else { "[ ]" },
                            if task.stale { "stale" } else { &task.activity },
                            task.title
                        ),
                        task.stale,
                        panel.focused && panel.selected.as_ref() == Some(&task.id),
                    )
                }));
            }
            rows
        })
        .collect::<Vec<_>>();
    let list_area = Rect {
        height: area.height.saturating_sub(2),
        ..area
    };
    super::agent_sidebar::render_agent_list(
        buffer,
        list_area,
        &rows,
        Some("no active tasks."),
        config,
        scroll,
        hits,
        |_| 1,
        |buffer, rect, (header, id, label, stale, selected), hits| {
            let mut style = Style::default().fg(if *selected {
                config.palette.accent
            } else {
                color
            });
            if *header {
                style = style.add_modifier(Modifier::BOLD);
                hits.koala_groups.push((rect, id.clone()));
            } else if let Some(id) = id {
                hits.koala_tasks.push((rect, id.clone()));
            }
            if *stale {
                style = style.add_modifier(Modifier::DIM);
            }
            put_text(buffer, rect.x, rect.y, rect.width, label, style);
        },
    );
    if area.height >= 2 {
        let hint = panel
            .prompt
            .as_ref()
            .map(|(_, name)| format!("group: {name}_"))
            .unwrap_or_else(|| {
                format!(
                    "F8 focus · enter open · sound {}",
                    if panel.view.sound { "on" } else { "off" }
                )
            });
        put_text(
            buffer,
            area.x,
            area.bottom() - 2,
            area.width,
            &hint,
            Style::default().fg(color),
        );
        put_text(
            buffer,
            area.x,
            area.bottom() - 1,
            area.width,
            "space track · g group · m move · r rename · c fold · s sound",
            Style::default().fg(color),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::koala::{KoalaGroup, KoalaTask};

    fn state() -> ClientShellState {
        let mut state = ClientShellState::new(ClientShellConfig::from_config(&Config::default()));
        state.receive_koala(KoalaView {
            fresh: true,
            groups: vec![KoalaGroup {
                id: Some("work".into()),
                name: "Work".into(),
                collapsed: false,
                tasks: vec![KoalaTask {
                    id: "remote-only".into(),
                    title: "Unopened remote task".into(),
                    activity: "waiting".into(),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        });
        state
    }

    fn draw(state: &mut ClientShellState, area: Rect) -> Buffer {
        let mut buffer = Buffer::empty(area);
        let mut hits = ShellHitMap::default();
        render(
            &mut buffer,
            area,
            state.koala.as_ref().unwrap(),
            &state.config,
            &mut state.agent_scroll,
            &mut hits,
        );
        state.hits = hits;
        buffer
    }

    #[test]
    fn koala_rows_exist_without_panes_and_keep_distinct_hits() {
        let state = state();
        let area = Rect::new(0, 0, 60, 15);
        let mut buffer = Buffer::empty(area);
        let mut hits = ShellHitMap::default();
        render(
            &mut buffer,
            area,
            state.koala.as_ref().unwrap(),
            &state.config,
            &mut 0,
            &mut hits,
        );
        assert_eq!(hits.koala_tasks.len(), 1);
        assert_eq!(hits.koala_tasks[0].1, "remote-only");
        assert_eq!(hits.koala_groups[0].1.as_deref(), Some("work"));
        assert!(hits.agents.is_empty());
        assert!(hits.endpoint_agents.is_empty());
        let text: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(text.contains("Unopened remote task"));
        assert!(text.contains("1 [ ] waiting"));
    }

    #[test]
    fn koala_shortcut_opens_catalog_identity_and_stale_rows_remain_visible() {
        let mut state = state();
        let mut outcome = ClientShellInput::default();
        state.record_binding(
            crate::input::KeybindMatch::Action(crate::input::KeybindAction::FocusAgent(0)),
            &mut outcome,
        );
        assert!(
            matches!(&outcome.actions[0], ClientShellAction::Koala(command) if command["id"] == "remote-only")
        );
        assert!(outcome.requests.is_empty());
        state.koala_disconnected();
        let panel = state.koala.as_ref().unwrap();
        assert!(!panel.view.fresh);
        assert!(panel.view.groups[0].tasks[0].stale);
        assert_eq!(panel.selected.as_deref(), Some("remote-only"));
    }

    #[test]
    fn koala_group_collapse_excludes_hidden_tasks_from_index_shortcuts() {
        let mut state = state();
        state.koala.as_mut().unwrap().view.groups[0].collapsed = true;
        assert!(state.koala_index(0).is_none());
        assert!(
            !state.indexed_navigation_target_exists(&crate::input::KeybindMatch::Action(
                crate::input::KeybindAction::FocusAgent(0)
            ))
        );
    }

    #[test]
    fn koala_keyboard_navigation_reveals_tasks_across_headers_and_row_gaps() {
        let mut state = state();
        state.config.agents.row_gap = 2;
        let panel = state.koala.as_mut().unwrap();
        panel.focused = true;
        panel.view.groups = (0..3)
            .map(|group| KoalaGroup {
                id: Some(format!("group-{group}")),
                name: format!("Group {group}"),
                collapsed: group == 1,
                tasks: (0..4)
                    .map(|task| KoalaTask {
                        id: format!("{group}-{task}"),
                        title: format!("Task {group}-{task}"),
                        activity: "waiting".into(),
                        ..Default::default()
                    })
                    .collect(),
            })
            .collect();
        panel.selected = Some("0-0".into());
        let area = Rect::new(0, 0, 60, 11);
        draw(&mut state, area);
        for code in [KeyCode::Down, KeyCode::Up] {
            for _ in 0..7 {
                let key = crate::input::TerminalKey::new(code, KeyModifiers::empty());
                assert!(state.koala_key(&key, &mut ClientShellInput::default()));
                draw(&mut state, area);
                let selected = state.koala.as_ref().unwrap().selected.as_ref().unwrap();
                assert!(state.hits.koala_tasks.iter().any(|(_, id)| id == selected));
            }
            if code == KeyCode::Down {
                assert_eq!(
                    state.koala.as_ref().unwrap().selected.as_deref(),
                    Some("2-3")
                );
                assert!(state.agent_scroll > 0);
                let text: String = draw(&mut state, area)
                    .content()
                    .iter()
                    .map(|cell| cell.symbol())
                    .collect();
                assert!(text.contains("8 [ ] waiting Task 2-3"));
                assert_eq!(state.koala_index(7).as_deref(), Some("2-3"));
            }
        }
        assert_eq!(
            state.koala.as_ref().unwrap().selected.as_deref(),
            Some("0-0")
        );
    }

    #[test]
    fn koala_hidden_selection_survives_arrows_and_can_unfold_its_group() {
        let mut state = state();
        let mut view = state.koala.as_ref().unwrap().view.clone();
        view.groups[0].collapsed = true;
        state.receive_koala(view);
        state.koala.as_mut().unwrap().focused = true;
        let mut outcome = ClientShellInput::default();
        for code in [KeyCode::Up, KeyCode::Down, KeyCode::Char('c')] {
            state.koala_key(
                &crate::input::TerminalKey::new(code, KeyModifiers::empty()),
                &mut outcome,
            );
        }
        assert_eq!(
            state.koala.as_ref().unwrap().selected.as_deref(),
            Some("remote-only")
        );
        assert!(matches!(
            &outcome.actions[0],
            ClientShellAction::Koala(command) if command["type"] == "collapse" && command["group"] == "work"
        ));
    }

    #[test]
    fn koala_disconnect_preserves_actionable_failure_details() {
        let mut state = state();
        let detail = "server requires task-events support";
        state.koala_notice(detail.into());
        state.koala_disconnected();
        assert_eq!(state.koala.as_ref().unwrap().view.message, detail);
    }

    #[test]
    fn koala_committed_text_and_paste_never_reach_the_focused_terminal() {
        use crate::input::TextCommit;
        use crate::raw_input::RawInputEvent;

        let mut state = state();
        state.set_snapshot(Box::new(super::super::tests::snapshot()));
        let forwarded = state.handle_raw_events(vec![RawInputEvent::Paste("terminal".into())]);
        assert!(forwarded
            .requests
            .iter()
            .any(|request| matches!(request, ClientMessage::ClientShellPaneInput { .. })));
        state.koala.as_mut().unwrap().focused = true;
        for prompting in [false, true] {
            state.koala.as_mut().unwrap().prompt = prompting.then(|| (None, String::new()));
            let outcome = state.handle_raw_events(vec![
                RawInputEvent::Text(TextCommit::new("group\n")),
                RawInputEvent::Paste(format!("\x1b\t{}", "é".repeat(100))),
            ]);
            assert!(outcome.requests.is_empty());
            assert!(outcome.actions.is_empty());
            if prompting {
                let name = &state.koala.as_ref().unwrap().prompt.as_ref().unwrap().1;
                assert_eq!(name.chars().count(), 80);
                assert_eq!(name, &format!("group{}", "é".repeat(75)));
            }
        }
        state.koala.as_mut().unwrap().prompt = None;
        for code in [KeyCode::Char('c'), KeyCode::Char('g'), KeyCode::Char('s')] {
            let outcome = state.handle_raw_events(vec![RawInputEvent::Key(
                crate::input::TerminalKey::new(code, KeyModifiers::CONTROL),
            )]);
            assert!(outcome.requests.is_empty());
            assert!(outcome.actions.is_empty());
            assert!(state.koala.as_ref().unwrap().prompt.is_none());
        }
    }

    #[test]
    #[ignore = "manual fixed-geometry Koala panel scaling profile"]
    fn koala_render_scale_profile() {
        let area = Rect::new(0, 0, 80, 40);
        for count in [1, 15] {
            let mut state = state();
            state.koala.as_mut().unwrap().view.groups[0].tasks = (0..count)
                .map(|index| KoalaTask {
                    id: index.to_string(),
                    title: format!("Remote task {index}"),
                    activity: "waiting".into(),
                    ..Default::default()
                })
                .collect();
            let started = std::time::Instant::now();
            for _ in 0..1000 {
                std::hint::black_box(draw(&mut state, area));
            }
            eprintln!(
                "koala tasks={count} renders=1000 elapsed={:?}",
                started.elapsed()
            );
        }
    }
}
