//! The string values the frontend and backend both name for domain enums.
//!
//! `src/generated/domain.ts` is produced from the lists on those enums. A test
//! fails when the two disagree, so a new status or tab is one Rust edit.

use crate::memory::MemoryEntryType;
use crate::session::{SessionKind, SessionStatus};
use crate::settings::{DispatchTarget, PaneLayout, WorkspaceTab};
use crate::steps::{StepOrigin, StepStatus, StepsPhase};
use crate::task::TaskStatus;

const HEADER: &str = "/**\n * Generated from the Rust domain enums. Do not edit.\n * `cargo test domain::generated_typescript_is_current` fails when this is stale.\n */\n\n";

fn emit_list(name: &str, values: &[&str]) -> String {
    let inner = values
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("export const {name} = [{inner}] as const;\n")
}

fn emit_default(name: &str, value: &str) -> String {
    format!("export const {name} = \"{value}\" as const;\n")
}

/// The TypeScript const lists that have to match the Rust enums.
pub fn typescript_bindings() -> String {
    let mut out = String::from(HEADER);
    out.push_str(&emit_list(
        "PANE_LAYOUTS",
        &PaneLayout::ALL.map(PaneLayout::as_str),
    ));
    out.push_str(&emit_default(
        "DEFAULT_LAYOUT",
        PaneLayout::DEFAULT.as_str(),
    ));
    out.push('\n');
    out.push_str(&emit_list(
        "WORKSPACE_TABS",
        &WorkspaceTab::ALL.map(WorkspaceTab::as_str),
    ));
    out.push_str(&emit_default("DEFAULT_TAB", WorkspaceTab::DEFAULT.as_str()));
    out.push('\n');
    out.push_str(&emit_list(
        "DISPATCH_TARGETS",
        &DispatchTarget::ALL.map(DispatchTarget::as_str),
    ));
    out.push_str(&emit_default(
        "DEFAULT_DISPATCH",
        DispatchTarget::DEFAULT.as_str(),
    ));
    out.push('\n');
    out.push_str(&emit_list(
        "SESSION_STATUSES",
        &SessionStatus::ALL.map(SessionStatus::as_str),
    ));
    out.push_str(&emit_list(
        "SESSION_KINDS",
        &SessionKind::ALL.map(SessionKind::as_str),
    ));
    out.push_str(&emit_list(
        "TASK_STATUSES",
        &TaskStatus::ALL.map(TaskStatus::as_str),
    ));
    out.push_str(&emit_list(
        "STEPS_PHASES",
        &StepsPhase::ALL.map(StepsPhase::as_str),
    ));
    out.push_str(&emit_list(
        "STEP_STATUSES",
        &StepStatus::ALL.map(StepStatus::as_str),
    ));
    out.push_str(&emit_list(
        "STEP_ORIGINS",
        &StepOrigin::ALL.map(StepOrigin::as_str),
    ));
    out.push_str(&emit_list(
        "MEMORY_ENTRY_TYPES",
        &MemoryEntryType::ALL.map(MemoryEntryType::as_str),
    ));
    out
}

fn generated_ts_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/generated/domain.ts")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    #[test]
    fn generated_typescript_is_current() {
        let expected = typescript_bindings();
        let path = generated_ts_path();
        let actual = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            actual,
            expected,
            "{} is stale; rewrite it from domain::typescript_bindings()",
            path.display()
        );
    }

    #[test]
    fn unknown_enum_values_are_errors() {
        assert!(matches!(
            SessionStatus::parse("exploded"),
            Err(Error::Invalid(message)) if message.contains("exploded")
        ));
        assert!(matches!(
            SessionKind::parse("wizard"),
            Err(Error::Invalid(message)) if message.contains("wizard")
        ));
        assert!(matches!(
            TaskStatus::parse("later"),
            Err(Error::Invalid(message)) if message.contains("later")
        ));
        assert!(matches!(
            StepsPhase::parse("maybe"),
            Err(Error::Invalid(message)) if message.contains("maybe")
        ));
        assert!(matches!(
            StepStatus::parse("blocked"),
            Err(Error::Invalid(message)) if message.contains("blocked")
        ));
        assert!(matches!(
            StepOrigin::parse("system"),
            Err(Error::Invalid(message)) if message.contains("system")
        ));
        assert!(matches!(
            MemoryEntryType::parse("secret"),
            Err(Error::Invalid(message)) if message.contains("secret")
        ));
    }
}
