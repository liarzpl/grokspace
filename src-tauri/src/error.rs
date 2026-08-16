use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),

    #[error("could not serialize project settings: {0}")]
    Json(#[from] serde_json::Error),

    #[error("could not resolve the home directory")]
    NoHomeDir,

    #[error("the database connection is unavailable because a previous operation panicked")]
    StatePoisoned,

    #[error("no project found with id {0}")]
    ProjectNotFound(String),

    #[error("{0}")]
    Invalid(String),
}

/// The frontend receives errors as plain strings, so `invoke` rejections read as
/// the same message the Rust side logs.
impl Serialize for Error {
    // Spelled out because the `Result` alias below shadows the std one.
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
