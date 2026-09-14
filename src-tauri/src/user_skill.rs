//! User skills (FEAT-025): `~/.grokspace/skills/<name>/SKILL.md`.
//! Does not install into `~/.grok/skills/` (ASK FIRST).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db;
use crate::error::{Error, Result};

const DIR: &str = "skills";
const FILE: &str = "SKILL.md";
const MAX: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillRecord {
    pub name: String,
    pub path: String,
}

pub fn user_skills_dir() -> Result<PathBuf> {
    Ok(db::data_dir()?.join(DIR))
}

fn validate_name(raw: &str) -> Result<String> {
    crate::playbook::validate_name(raw)
        .map_err(|_| Error::Invalid("skill name must be letters, digits, '.', '_' or '-'".into()))
}

pub fn write_user_skill(root: &Path, name: &str, markdown: &str) -> Result<UserSkillRecord> {
    let name = validate_name(name)?;
    if markdown.trim().is_empty() || markdown.len() > MAX {
        return Err(Error::Invalid(
            "skill markdown is empty or too large".into(),
        ));
    }
    let dir = root.join(&name);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(FILE), markdown)?;
    Ok(UserSkillRecord {
        name,
        path: dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn save_user_skill(name: String, markdown: String) -> Result<UserSkillRecord> {
    write_user_skill(&user_skills_dir()?, &name, &markdown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn save_writes_skill_md_under_the_library_not_grok_skills() {
        let root = TempDir::new().unwrap();
        let rec = write_user_skill(
            root.path(),
            "review-flow",
            "---\nname: review-flow\n---\nWrite to $GROKSPACE_GRAPH_FILE.\n",
        )
        .unwrap();
        assert_eq!(rec.name, "review-flow");
        assert!(
            std::fs::read_to_string(root.path().join("review-flow").join(FILE))
                .unwrap()
                .contains("$GROKSPACE_GRAPH_FILE")
        );
        assert!(!rec.path.contains(".grok/skills"));
        assert!(user_skills_dir()
            .unwrap()
            .ends_with(std::path::Path::new(".grokspace/skills")));
        assert!(validate_name("../etc").is_err());
        assert!(write_user_skill(root.path(), "x", "   ").is_err());
    }
}
