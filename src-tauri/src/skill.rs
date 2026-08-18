//! The skills GrokSpace bundles, and how they get to where `grok` looks.
//!
//! Grok discovers skills from `~/.grok/skills/`, so installing into the user's home
//! rather than into their repository is what makes one install work for every
//! project and leave no trace in anyone's git history.
//!
//! Installing is on request rather than on boot. Writing into a user's home the
//! first time an app starts is not GrokSpace's decision to make.
//!
//! A skill is a directory of files rather than one file. It began as one, which was
//! right while the only skill was short; the graph skill now carries a topology
//! catalogue and a file contract that no agent should have to read in order to write
//! a two-node graph. Grok loads `SKILL.md` and follows its references on demand,
//! which is the whole reason to split them.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};

/// Where Grok looks, relative to the home directory.
const SKILLS_DIR: &str = ".grok/skills";

/// The file Grok reads first, and without which it does not see the skill at all.
const SKILL_FILE: &str = "SKILL.md";

/// Whether a bundled skill is in place, and whether it is the version this build
/// ships.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    /// The skill's directory, which is what the panel names. A skill of several
    /// files has no one path worth showing.
    pub path: String,
    pub installed: bool,
    /// False when an older GrokSpace installed a different version, or when any one
    /// of a multi-file skill's files is missing or stale.
    pub current: bool,
}

/// One file in a skill, at a path relative to the skill's own directory.
pub struct SkillFile {
    /// Forward slashes, split per component so this works off Unix too. Must be
    /// relative and must not climb: `is_safe` is what holds that, and a test names it.
    pub path: &'static str,
    pub content: &'static str,
}

impl SkillFile {
    /// Whether this path stays inside the skill's directory.
    ///
    /// These paths are compile-time constants from this repository, so nothing
    /// hostile can reach them. The check is here because the consequence of getting
    /// it wrong — writing anywhere under the user's home — is bad enough to be worth
    /// one line and a test.
    fn is_safe(&self) -> bool {
        !self.path.is_empty()
            && !self.path.starts_with('/')
            && self
                .path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
    }

    fn under(&self, dir: &Path) -> PathBuf {
        self.path
            .split('/')
            .fold(dir.to_path_buf(), |at, part| at.join(part))
    }
}

/// A skill this build carries: the directory it belongs in, and its files.
///
/// Contents are `&'static str` because they come from `include_str!` at compile
/// time — a skill that could be missing at runtime would be a skill that could
/// silently not install.
pub struct Skill {
    /// The directory under `~/.grok/skills`, which is also the skill's name.
    pub dir: &'static str,
    pub files: &'static [SkillFile],
}

impl Skill {
    /// One bundled file's contents.
    ///
    /// Only the tests need this — the ones checking that a skill still names the
    /// environment variables and status values the code around it relies on. Nothing
    /// at runtime reads a skill's text; it is written out and Grok reads it from there.
    #[cfg(test)]
    pub fn content(&self, path: &str) -> Option<&'static str> {
        self.files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.content)
    }

    fn directory(&self) -> Result<PathBuf> {
        Ok(dirs::home_dir()
            .ok_or(Error::NoHomeDir)?
            .join(SKILLS_DIR)
            .join(self.dir))
    }

    /// Split from `status` so the tests can ask about a temporary home rather than
    /// the real one.
    fn status_of(&self, dir: &Path) -> SkillStatus {
        // Installed is about `SKILL.md` alone, because that is what Grok looks for.
        // Current is about every file: a stale reference is a skill describing a
        // contract this build no longer honours, which is worse than an absent one.
        let installed = dir.join(SKILL_FILE).is_file();
        let current = installed
            && self.files.iter().all(|file| {
                std::fs::read_to_string(file.under(dir)).ok().as_deref() == Some(file.content)
            });
        SkillStatus {
            path: dir.to_string_lossy().into_owned(),
            installed,
            current,
        }
    }

    pub fn status(&self) -> Result<SkillStatus> {
        Ok(self.status_of(&self.directory()?))
    }

    /// Installs, or refreshes, the skill.
    pub fn install(&self) -> Result<SkillStatus> {
        let dir = self.directory()?;
        self.install_at(&dir)
    }

    fn install_at(&self, dir: &Path) -> Result<SkillStatus> {
        for file in self.files {
            if !file.is_safe() {
                return Err(Error::Invalid(format!(
                    "the bundled skill `{}` names an unsafe path: {}",
                    self.dir, file.path
                )));
            }
        }

        for file in self.files {
            let path = file.under(dir);
            // Written only when the contents differ, which keeps this idempotent
            // without a version marker to keep in step with the files. Checked per
            // file so refreshing one reference does not rewrite the rest.
            if std::fs::read_to_string(&path).ok().as_deref() == Some(file.content) {
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, file.content)?;
        }

        // Files an older version left behind are not removed. Deleting from a user's
        // home something this build did not write is a bigger risk than a stale
        // reference nothing links to.
        Ok(self.status_of(dir))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: Skill = Skill {
        dir: "grokspace-sample",
        files: &[
            SkillFile {
                path: "SKILL.md",
                content:
                    "---\nname: grokspace-sample\n---\nDo the thing. See references/more.md.\n",
            },
            SkillFile {
                path: "references/more.md",
                content: "# More\n\nThe long version.\n",
            },
        ],
    };

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir should be created")
    }

    #[test]
    fn a_skill_that_is_not_there_reads_as_neither_installed_nor_current() {
        let home = home();

        let status = SAMPLE.status_of(home.path());

        assert!(!status.installed);
        assert!(!status.current);
    }

    #[test]
    fn installing_creates_every_directory_it_needs() {
        // Grok's skills directory does not exist on a machine that has never had one,
        // and nor does a skill's own references/ subdirectory.
        let home = home();
        let dir = home.path().join(SKILLS_DIR).join(SAMPLE.dir);

        let status = SAMPLE.install_at(&dir).unwrap();

        assert!(status.installed && status.current);
        assert_eq!(
            std::fs::read_to_string(dir.join("references/more.md")).unwrap(),
            "# More\n\nThe long version.\n"
        );
    }

    #[test]
    fn the_reported_path_is_the_directory() {
        // A skill of several files has no one path worth naming, and the panel says
        // where installing writes.
        let home = home();
        let dir = home.path().join(SKILLS_DIR).join(SAMPLE.dir);

        assert_eq!(SAMPLE.install_at(&dir).unwrap().path, dir.to_string_lossy());
    }

    #[test]
    fn installing_twice_writes_nothing_the_second_time() {
        let home = home();
        let dir = home.path().to_path_buf();
        SAMPLE.install_at(&dir).unwrap();
        let before: Vec<_> = SAMPLE
            .files
            .iter()
            .map(|file| {
                std::fs::metadata(file.under(&dir))
                    .unwrap()
                    .modified()
                    .unwrap()
            })
            .collect();

        SAMPLE.install_at(&dir).unwrap();

        let after: Vec<_> = SAMPLE
            .files
            .iter()
            .map(|file| {
                std::fs::metadata(file.under(&dir))
                    .unwrap()
                    .modified()
                    .unwrap()
            })
            .collect();
        assert_eq!(
            before, after,
            "an install that changes nothing must not write"
        );
    }

    #[test]
    fn a_stale_reference_makes_the_skill_not_current() {
        // The case that matters most for a multi-file skill: SKILL.md is the version
        // this build ships, but a reference it points at describes an older contract.
        // Reporting that as installed-and-current would leave an agent following
        // rules this build no longer honours.
        let home = home();
        let dir = home.path().to_path_buf();
        SAMPLE.install_at(&dir).unwrap();
        std::fs::write(dir.join("references/more.md"), "the old version\n").unwrap();

        let stale = SAMPLE.status_of(&dir);
        assert!(stale.installed, "SKILL.md is still there");
        assert!(!stale.current, "but one of its references is not ours");

        assert!(SAMPLE.install_at(&dir).unwrap().current);
    }

    #[test]
    fn a_missing_reference_makes_it_not_current_either() {
        let home = home();
        let dir = home.path().to_path_buf();
        SAMPLE.install_at(&dir).unwrap();
        std::fs::remove_file(dir.join("references/more.md")).unwrap();

        assert!(!SAMPLE.status_of(&dir).current);
    }

    #[test]
    fn an_older_skill_md_is_installed_but_not_current() {
        // Which is what makes the button offer to refresh it rather than hide.
        let home = home();
        let dir = home.path().to_path_buf();
        std::fs::write(
            dir.join(SKILL_FILE),
            "---\nname: grokspace-sample\n---\nold\n",
        )
        .unwrap();

        let stale = SAMPLE.status_of(&dir);
        assert!(stale.installed && !stale.current);

        assert!(SAMPLE.install_at(&dir).unwrap().current);
    }

    #[test]
    fn a_reference_without_skill_md_is_not_installed() {
        // Grok looks for SKILL.md and nothing else, so a directory holding only
        // references is a skill Grok cannot see.
        let home = home();
        let dir = home.path().to_path_buf();
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(
            dir.join("references/more.md"),
            "# More\n\nThe long version.\n",
        )
        .unwrap();

        assert!(!SAMPLE.status_of(&dir).installed);
    }

    #[test]
    fn a_path_that_would_climb_out_of_the_skill_is_refused() {
        // These paths are our own compile-time constants, so this cannot be reached
        // by anything hostile. It is here because the consequence — writing anywhere
        // under the user's home — is worth one check.
        for bad in [
            "../escape.md",
            "/etc/passwd",
            "references/../../escape.md",
            "",
        ] {
            let file = SkillFile {
                path: bad,
                content: "x",
            };
            assert!(!file.is_safe(), "`{bad}` should be refused");
        }
        for good in ["SKILL.md", "references/catalog.md", "a/b/c.md"] {
            let file = SkillFile {
                path: good,
                content: "x",
            };
            assert!(file.is_safe(), "`{good}` should be allowed");
        }
    }

    #[test]
    fn an_unsafe_path_stops_the_install_rather_than_writing_some_of_it() {
        const BAD: Skill = Skill {
            dir: "grokspace-bad",
            files: &[
                SkillFile {
                    path: "SKILL.md",
                    content: "fine\n",
                },
                SkillFile {
                    path: "../escape.md",
                    content: "not fine\n",
                },
            ],
        };
        let home = home();
        let dir = home.path().join("skill");

        assert!(BAD.install_at(&dir).is_err());
        assert!(
            !dir.join(SKILL_FILE).exists(),
            "the check runs over every file before any of them is written"
        );
    }
}
