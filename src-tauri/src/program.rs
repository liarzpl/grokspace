//! Finding the programs GrokSpace runs.
//!
//! Its own module because there are two callers now: sessions look for `grok`, and
//! the diff panel looks for `git`. The lesson the skill installer taught is to move
//! a thing when the second copy is about to be written rather than after.

use std::path::PathBuf;

use crate::error::{Error, Result};

/// Where a program might be when it is not on `PATH`.
///
/// A macOS app launched from Finder never reads the shell profile, so anything
/// installed into a user-local bin directory is invisible to a plain `PATH` lookup.
/// This list is what `grok`'s own installer and the usual package managers use.
fn fallback_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    [
        home.as_ref().map(|home| home.join(".local/bin")),
        home.as_ref().map(|home| home.join(".grok/bin")),
        Some(PathBuf::from("/usr/local/bin")),
        Some(PathBuf::from("/opt/homebrew/bin")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The absolute path to `program`, or `None` when it is nowhere to be found.
///
/// Separate from `resolve` because the two callers want different things from a
/// miss: a session cannot start without `grok` and says how to install it, while the
/// diff panel simply has nothing to show and says that instead.
pub fn find(program: &str) -> Option<String> {
    if program.contains('/') {
        return Some(program.to_string());
    }

    let on_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file());
    if let Some(found) = on_path {
        return Some(found.to_string_lossy().into_owned());
    }

    fallback_dirs()
        .into_iter()
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
        .map(|found| found.to_string_lossy().into_owned())
}

/// The same lookup, but an error naming how to install what is missing.
pub fn resolve(program: &str) -> Result<String> {
    find(program).ok_or_else(|| {
        Error::Pty(format!(
            "could not find `{program}` on PATH or in the usual install locations. \
             Install it with: curl -fsSL https://x.ai/cli/install.sh | bash"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_a_slash_is_taken_as_given() {
        // Somebody who names a path means that path, not whatever is on PATH.
        assert_eq!(find("/usr/bin/env").as_deref(), Some("/usr/bin/env"));
    }

    #[test]
    fn something_on_path_is_found_absolutely() {
        // `sh` is on PATH everywhere this can run.
        let found = find("sh").expect("sh should be on PATH");

        assert!(PathBuf::from(&found).is_absolute());
        assert!(found.ends_with("/sh"));
    }

    #[test]
    fn nothing_is_found_for_a_program_that_does_not_exist() {
        assert_eq!(find("grokspace-no-such-binary"), None);
    }

    #[test]
    fn resolving_a_missing_program_explains_how_to_install_it() {
        let error = resolve("grokspace-no-such-binary").unwrap_err();

        assert!(error.to_string().contains("could not find"));
        assert!(
            error.to_string().contains("x.ai/cli/install.sh"),
            "the message is what someone reads when a session will not start"
        );
    }
}
