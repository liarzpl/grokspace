//! Named local permission policy (FEAT-014).
//!
//! User globs in `~/.grokspace/permission-policy.json` and
//! `<project>/.grokspace/permission-policy.json` (the project folder, never a
//! worktree). Deny > ask > allow-once-similar. Allow-similar is `allow_once`
//! only. A glob that does not compile is skipped, not Always.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::acp::PermissionOption;
use crate::db;
use crate::error::{Error, Result};
use crate::project::GROKSPACE_DIR;

const FILE_NAME: &str = "permission-policy.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyAction {
    Deny,
    Ask,
    AllowOnceSimilar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRule {
    pub action: PolicyAction,
    pub pattern: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PolicyFile {
    #[serde(default)]
    rules: Vec<PolicyRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicy {
    pub path: String,
    pub project_file: String,
    pub rules: Vec<PolicyRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Deny,
    Ask,
    AllowOnceSimilar,
}

pub fn user_policy_path() -> Result<PathBuf> {
    Ok(db::data_dir()?.join(FILE_NAME))
}

pub fn project_policy_path(project_path: &Path) -> PathBuf {
    project_path.join(GROKSPACE_DIR).join(FILE_NAME)
}

pub fn load_rules(project_path: Option<&Path>) -> Vec<PolicyRule> {
    let mut rules = load_file(&user_policy_path().ok().unwrap_or_default());
    if let Some(project) = project_path {
        rules.extend(load_file(&project_policy_path(project)));
    }
    rules
}

fn load_file(path: &Path) -> Vec<PolicyRule> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<PolicyFile>(&text)
        .map(|file| {
            file.rules
                .into_iter()
                .filter(|rule| !rule.pattern.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn save_file(path: &Path, rules: &[PolicyRule]) -> Result<()> {
    validate_rules(rules)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(&PolicyFile {
        rules: rules.to_vec(),
    })?;
    fs::write(path, format!("{body}\n"))?;
    Ok(())
}

fn validate_rules(rules: &[PolicyRule]) -> Result<()> {
    for rule in rules {
        if rule.pattern.trim().is_empty() || glob_matches(&rule.pattern, "").is_none() {
            return Err(Error::Invalid(format!(
                "`{}` is not a usable glob",
                rule.pattern
            )));
        }
        if rule.action == PolicyAction::AllowOnceSimilar && too_wide_allow(&rule.pattern) {
            return Err(Error::Invalid(
                "allow-once-similar cannot be a pattern that matches everything".into(),
            ));
        }
    }
    Ok(())
}

pub fn decide(rules: &[PolicyRule], summary: &str) -> PolicyDecision {
    let mut deny = false;
    let mut ask = false;
    let mut allow = false;
    for rule in rules {
        if glob_matches(&rule.pattern, summary) != Some(true) {
            continue;
        }
        match rule.action {
            PolicyAction::Deny => deny = true,
            PolicyAction::Ask => ask = true,
            PolicyAction::AllowOnceSimilar if !too_wide_allow(&rule.pattern) => allow = true,
            PolicyAction::AllowOnceSimilar => {}
        }
    }
    if deny {
        PolicyDecision::Deny
    } else if ask {
        PolicyDecision::Ask
    } else if allow {
        PolicyDecision::AllowOnceSimilar
    } else {
        PolicyDecision::Ask
    }
}

/// `None` means show chips. Never selects `allow_always`.
pub fn auto_reply(decision: PolicyDecision, options: &[PermissionOption]) -> Option<bool> {
    match decision {
        PolicyDecision::Ask => None,
        PolicyDecision::Deny => has_kind(options, "reject_once").then_some(false),
        PolicyDecision::AllowOnceSimilar => has_kind(options, "allow_once").then_some(true),
    }
}

pub fn auto_reply_for(
    project_path: Option<&Path>,
    summary: &str,
    options: &[PermissionOption],
) -> Option<bool> {
    auto_reply(decide(&load_rules(project_path), summary), options)
}

fn has_kind(options: &[PermissionOption], kind: &str) -> bool {
    options.iter().any(|option| option.kind == kind)
}

fn too_wide_allow(pattern: &str) -> bool {
    pattern.trim().chars().all(|ch| ch == '*' || ch == '?')
}

/// `None` = unusable glob (skip the rule; never Always). `*` / `**` match any
/// run of characters; `?` is one character.
fn glob_matches(pattern: &str, text: &str) -> Option<bool> {
    if !glob_ok(pattern) {
        return None;
    }
    Some(glob_at(pattern, text))
}

fn glob_ok(pattern: &str) -> bool {
    if pattern.is_empty() || pattern.ends_with('\\') {
        return false;
    }
    let opens = pattern.chars().filter(|ch| *ch == '[').count();
    let closes = pattern.chars().filter(|ch| *ch == ']').count();
    opens == closes
}

fn glob_at(pat: &str, text: &str) -> bool {
    if pat.is_empty() {
        return text.is_empty();
    }
    if pat.starts_with('*') {
        let rest = pat.trim_start_matches('*');
        if rest.is_empty() {
            return true;
        }
        let mut rest_text = text;
        loop {
            if glob_at(rest, rest_text) {
                return true;
            }
            let Some(ch) = rest_text.chars().next() else {
                return false;
            };
            rest_text = &rest_text[ch.len_utf8()..];
        }
    }
    let Some(wanted) = pat.chars().next() else {
        return false;
    };
    if wanted == '?' {
        let Some(ch) = text.chars().next() else {
            return false;
        };
        return glob_at(&pat[wanted.len_utf8()..], &text[ch.len_utf8()..]);
    }
    let Some(ch) = text.chars().next() else {
        return false;
    };
    ch == wanted && glob_at(&pat[wanted.len_utf8()..], &text[ch.len_utf8()..])
}

#[tauri::command]
pub fn read_permission_policy() -> Result<PermissionPolicy> {
    snapshot()
}

#[tauri::command]
pub fn write_permission_policy(rules: Vec<PolicyRule>) -> Result<PermissionPolicy> {
    save_file(&user_policy_path()?, &rules)?;
    snapshot()
}

fn snapshot() -> Result<PermissionPolicy> {
    let path = user_policy_path()?;
    Ok(PermissionPolicy {
        path: path.to_string_lossy().into_owned(),
        project_file: format!("{GROKSPACE_DIR}/{FILE_NAME}"),
        rules: load_file(&path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::PermissionOption;
    use tempfile::TempDir;

    fn rule(action: PolicyAction, pattern: &str) -> PolicyRule {
        PolicyRule {
            action,
            pattern: pattern.into(),
        }
    }

    fn opts(kinds: &[&str]) -> Vec<PermissionOption> {
        kinds
            .iter()
            .map(|kind| PermissionOption {
                option_id: (*kind).into(),
                kind: (*kind).into(),
                name: (*kind).into(),
            })
            .collect()
    }

    #[test]
    fn deny_wins_and_allow_similar_cannot_widen_it() {
        let rules = vec![
            rule(PolicyAction::AllowOnceSimilar, "Edit **"),
            rule(PolicyAction::Deny, "Edit secrets/**"),
            rule(PolicyAction::Deny, "*rm*"),
        ];
        let once = opts(&["allow_once", "reject_once", "allow_always"]);
        assert_eq!(
            decide(&rules, "Edit src/auth.ts"),
            PolicyDecision::AllowOnceSimilar
        );
        assert_eq!(
            decide(&rules, "Edit secrets/token.env"),
            PolicyDecision::Deny
        );
        assert_eq!(decide(&rules, "Bash rm -rf /tmp"), PolicyDecision::Deny);
        assert_eq!(
            auto_reply(decide(&rules, "Edit secrets/token.env"), &once),
            Some(false)
        );
        assert_eq!(
            auto_reply(PolicyDecision::AllowOnceSimilar, &opts(&["allow_always"])),
            None
        );
    }

    #[test]
    fn a_bad_glob_does_not_fail_open_to_always() {
        let rules = vec![rule(PolicyAction::AllowOnceSimilar, "Edit src/[")];
        assert_eq!(glob_matches("Edit src/[", "Edit src/auth.ts"), None);
        assert_eq!(decide(&rules, "Edit src/auth.ts"), PolicyDecision::Ask);
        assert_eq!(
            decide(&[rule(PolicyAction::AllowOnceSimilar, "*")], "Edit a.ts"),
            PolicyDecision::Ask
        );
        assert!(validate_rules(&[rule(PolicyAction::AllowOnceSimilar, "*")]).is_err());
        assert!(validate_rules(&[rule(PolicyAction::Deny, "*")]).is_ok());
    }

    #[test]
    fn project_deny_wins_over_user_allow_and_bad_json_is_empty() {
        let root = TempDir::new().unwrap();
        let user = root.path().join("user.json");
        let project = root.path().join("acme");
        fs::create_dir_all(project.join(GROKSPACE_DIR)).unwrap();
        save_file(&user, &[rule(PolicyAction::AllowOnceSimilar, "Edit **")]).unwrap();
        save_file(
            &project_policy_path(&project),
            &[rule(PolicyAction::Deny, "Edit secrets/**")],
        )
        .unwrap();
        let mut rules = load_file(&user);
        rules.extend(load_file(&project_policy_path(&project)));
        assert_eq!(decide(&rules, "Edit secrets/a.env"), PolicyDecision::Deny);
        assert_eq!(
            decide(&rules, "Edit src/a.ts"),
            PolicyDecision::AllowOnceSimilar
        );

        let broken = root.path().join(FILE_NAME);
        fs::write(&broken, "{not json").unwrap();
        assert!(load_file(&broken).is_empty());
        assert_eq!(glob_matches("Edit src/**", "Edit src/lib/a.ts"), Some(true));
        assert_eq!(glob_matches("Edit src/**", "Edit tests/a.ts"), Some(false));
    }
}
