//! The skills GrokSpace bundles, and how they get to where `grok` looks.
//!
//! Grok discovers skills from `~/.grok/skills/`, so installing into the user's home
//! rather than into their repository is what makes one install work for every
//! project and leave no trace in anyone's git history.
//!
//! Installing is on request rather than on boot. Writing into a user's home the
//! first time an app starts is not GrokSpace's decision to make.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};

/// Where Grok looks, relative to the home directory.
const SKILLS_DIR: &str = ".grok/skills";

/// The one file a skill directory has to contain.
const SKILL_FILE: &str = "SKILL.md";

/// Whether a bundled skill is in place, and whether it is the version this build
/// ships.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub path: String,
    pub installed: bool,
    /// False when an older GrokSpace installed a different version of the skill.
    pub current: bool,
}

/// A skill this build carries: the directory it belongs in, and its contents.
///
/// Both are `&'static str` because both come from `include_str!` at compile time —
/// a skill that could be missing at runtime would be a skill that could silently
/// not install.
pub struct Skill {
    /// The directory under `~/.grok/skills`, which is also the skill's name.
    pub dir: &'static str,
    pub content: &'static str,
}

impl Skill {
    fn file(&self) -> Result<PathBuf> {
        Ok(dirs::home_dir()
            .ok_or(Error::NoHomeDir)?
            .join(SKILLS_DIR)
            .join(self.dir)
            .join(SKILL_FILE))
    }

    /// Split from `status` so the tests can ask about a path in a temporary home
    /// rather than the real one.
    fn status_of(&self, path: &Path) -> SkillStatus {
        let installed = std::fs::read_to_string(path).ok();
        SkillStatus {
            path: path.to_string_lossy().into_owned(),
            installed: installed.is_some(),
            current: installed.as_deref() == Some(self.content),
        }
    }

    pub fn status(&self) -> Result<SkillStatus> {
        Ok(self.status_of(&self.file()?))
    }

    /// Installs, or refreshes, the skill.
    ///
    /// Writing only when the contents differ keeps this idempotent without a version
    /// marker to keep in step with the file.
    pub fn install(&self) -> Result<SkillStatus> {
        let path = self.file()?;
        self.install_at(&path)
    }

    fn install_at(&self, path: &Path) -> Result<SkillStatus> {
        let status = self.status_of(path);
        if status.current {
            return Ok(status);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, self.content)?;
        Ok(self.status_of(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: Skill = Skill {
        dir: "grokspace-sample",
        content: "---\nname: grokspace-sample\n---\nDo the thing.\n",
    };

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir should be created")
    }

    #[test]
    fn a_skill_that_is_not_there_reads_as_neither_installed_nor_current() {
        let home = home();

        let status = SAMPLE.status_of(&home.path().join("SKILL.md"));

        assert!(!status.installed);
        assert!(!status.current);
    }

    #[test]
    fn installing_creates_the_directory_it_needs() {
        // Grok's skills directory does not exist on a machine that has never had one.
        let home = home();
        let path = home
            .path()
            .join(SKILLS_DIR)
            .join(SAMPLE.dir)
            .join(SKILL_FILE);

        let status = SAMPLE.install_at(&path).unwrap();

        assert!(status.installed && status.current);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SAMPLE.content);
    }

    #[test]
    fn installing_twice_writes_once() {
        let home = home();
        let path = home.path().join("SKILL.md");
        SAMPLE.install_at(&path).unwrap();
        let first = std::fs::metadata(&path).unwrap().modified().unwrap();

        SAMPLE.install_at(&path).unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            first,
            "an install that would change nothing must not touch the file"
        );
    }

    #[test]
    fn an_older_version_is_installed_but_not_current() {
        // Which is what makes the button offer to refresh it rather than hide.
        let home = home();
        let path = home.path().join("SKILL.md");
        std::fs::write(&path, "---\nname: grokspace-sample\n---\nold\n").unwrap();

        let stale = SAMPLE.status_of(&path);
        assert!(stale.installed && !stale.current);

        let refreshed = SAMPLE.install_at(&path).unwrap();
        assert!(refreshed.current);
    }
}
