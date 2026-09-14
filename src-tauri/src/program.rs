//! Finding the programs GrokSpace runs.
//!
//! Its own module because there are two callers now: sessions look for `grok`, and
//! the diff panel looks for `git`. The lesson the skill installer taught is to move
//! a thing when the second copy is about to be written rather than after.
//!
//! Hits live for the process lifetime. Every Diff load used to walk PATH for `git`
//! (twice), and a swarm start does the same for every worktree. A spawn failure
//! forgets the hit so the next lookup can recover after a reinstall.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::error::{Error, Result};

static FOUND: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Forget a cached hit so the next `find` walks PATH again.
///
/// Call this when spawning the cached binary fails. A process-lifetime cache is
/// only honest if a miss at run time can recover.
pub fn invalidate(program: &str) {
    if let Ok(mut cache) = FOUND.lock() {
        cache.remove(program);
    }
}

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

fn lookup(program: &str) -> Option<String> {
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

/// The absolute path to `program`, or `None` when it is nowhere to be found.
///
/// Separate from `resolve` because the two callers want different things from a
/// miss: a session cannot start without `grok` and says how to install it, while the
/// diff panel simply has nothing to show and says that instead.
pub fn find(program: &str) -> Option<String> {
    if program.contains('/') {
        return Some(program.to_string());
    }

    if let Ok(mut cache) = FOUND.lock() {
        match cache.get(program) {
            Some(path) if Path::new(path).is_file() => return Some(path.clone()),
            Some(_) => {
                cache.remove(program);
            }
            None => {}
        }
    }

    let found = lookup(program)?;
    if let Ok(mut cache) = FOUND.lock() {
        cache.insert(program.to_string(), found.clone());
    }
    Some(found)
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
pub(crate) fn seed_cache(program: &str, path: impl Into<String>) {
    FOUND
        .lock()
        .expect("program cache")
        .insert(program.to_string(), path.into());
}

#[cfg(test)]
pub(crate) fn cached(program: &str) -> Option<String> {
    FOUND.lock().ok()?.get(program).cloned()
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

    #[test]
    fn a_cached_hit_is_returned_without_walking_path() {
        // A name that is not on PATH would miss unless the cache already has it.
        seed_cache("grokspace-cache-probe", "/usr/bin/env");

        assert_eq!(
            find("grokspace-cache-probe").as_deref(),
            Some("/usr/bin/env")
        );
    }

    #[test]
    fn a_cached_path_that_is_gone_is_looked_up_again() {
        seed_cache("sh", "/grokspace-no-such-sh");

        let found = find("sh").expect("sh should be on PATH");
        assert_ne!(found, "/grokspace-no-such-sh");
        assert!(found.ends_with("/sh"));
    }

    #[test]
    fn invalidate_drops_a_cached_hit() {
        seed_cache("grokspace-cache-probe-forget", "/usr/bin/env");
        invalidate("grokspace-cache-probe-forget");

        assert_eq!(cached("grokspace-cache-probe-forget"), None);
        assert_eq!(find("grokspace-cache-probe-forget"), None);
    }
}
