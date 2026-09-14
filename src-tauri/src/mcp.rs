//! FEAT-039: list grok MCP from local config. Do not spawn, fetch, or fill ACP.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::project::{allows_project_hooks, get, trust_of, FolderTrust};
use crate::AppState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub origin: String,
    pub scope: String,
    pub transport: String,
    pub detail: String,
    pub held_off: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpVisibility {
    pub host_trust: FolderTrust,
    pub project_mcp_allowed: bool,
    pub servers: Vec<McpServerInfo>,
}

#[derive(Debug, Clone, Default)]
struct RawServer {
    name: String,
    command: Option<String>,
    url: Option<String>,
}

/// `~/.grok/config.toml` plus documented vendor/project files. Untrusted = project off.
pub fn collect_mcp_visibility(home: &Path, project: Option<(&Path, bool)>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let (user_rows, claude_on, cursor_on) = read_grok_toml(&home.join(".grok").join("config.toml"));
    add(
        &mut servers,
        user_rows,
        "~/.grok/config.toml",
        "user",
        false,
    );
    if claude_on {
        add(
            &mut servers,
            read_mcp_json(&home.join(".claude.json")),
            "~/.claude.json",
            "user",
            false,
        );
    }
    if let Some((root, allowed)) = project {
        add(
            &mut servers,
            read_grok_toml(&root.join(".grok").join("config.toml")).0,
            ".grok/config.toml",
            "project",
            !allowed,
        );
        add(
            &mut servers,
            read_mcp_json(&root.join(".mcp.json")),
            ".mcp.json",
            "project",
            !allowed,
        );
        if cursor_on {
            add(
                &mut servers,
                read_mcp_json(&root.join(".cursor").join("mcp.json")),
                ".cursor/mcp.json",
                "project",
                !allowed,
            );
        }
    }
    servers.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));
    servers
}

#[tauri::command]
pub fn mcp_visibility(state: State<'_, AppState>, id: Option<String>) -> Result<McpVisibility> {
    let home = dirs::home_dir().ok_or(Error::NoHomeDir)?;
    match id {
        None => Ok(McpVisibility {
            host_trust: FolderTrust::Unknown,
            project_mcp_allowed: false,
            servers: collect_mcp_visibility(&home, None),
        }),
        Some(id) => state.with_db(|conn| {
            let project = get(conn, &id)?;
            let session = state
                .folder_trust
                .lock()
                .map_err(|_| Error::StatePoisoned)?;
            let host_trust = trust_of(conn, &session, &project.path)?;
            let allowed = allows_project_hooks(host_trust);
            Ok(McpVisibility {
                host_trust,
                project_mcp_allowed: allowed,
                servers: collect_mcp_visibility(&home, Some((Path::new(&project.path), allowed))),
            })
        }),
    }
}

fn add(
    dest: &mut Vec<McpServerInfo>,
    rows: Vec<RawServer>,
    origin: &str,
    scope: &str,
    held_off: bool,
) {
    dest.extend(rows.into_iter().map(|row| {
        let (transport, detail) = match (row.url.as_deref(), row.command.as_deref()) {
            (Some(url), _) => ("http", url_detail(url)),
            (None, Some(cmd)) => ("stdio", cmd.split_whitespace().next().unwrap_or(cmd).into()),
            _ => ("unknown", String::new()),
        };
        McpServerInfo {
            name: row.name,
            origin: origin.into(),
            scope: scope.into(),
            transport: transport.into(),
            detail,
            held_off,
        }
    }));
}

fn read_capped(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 256 * 1024 {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn read_grok_toml(path: &Path) -> (Vec<RawServer>, bool, bool) {
    read_capped(path)
        .map(|text| parse_grok_config_toml(&text))
        .unwrap_or((Vec::new(), true, true))
}

fn read_mcp_json(path: &Path) -> Vec<RawServer> {
    read_capped(path)
        .and_then(|text| parse_mcp_json(&text))
        .unwrap_or_default()
}

fn parse_grok_config_toml(text: &str) -> (Vec<RawServer>, bool, bool) {
    let mut servers = Vec::new();
    let mut current: Option<RawServer> = None;
    let mut section = String::new();
    let mut claude_on = true;
    let mut cursor_on = true;
    for line in text.lines() {
        if let Some(header) = line
            .trim()
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
        {
            if let Some(done) = current.take() {
                servers.push(done);
            }
            section = header.to_string();
            if let Some(name) = mcp_server_name(header) {
                current = Some(RawServer {
                    name,
                    ..RawServer::default()
                });
            }
            continue;
        }
        if let Some(server) = current.as_mut() {
            if let Some(command) = kv(line, "command") {
                server.command = Some(command);
            }
            if let Some(url) = kv(line, "url") {
                server.url = Some(url);
            }
        } else if section == "compat.claude" {
            if let Some(value) = kv(line, "mcps") {
                claude_on = value == "true";
            }
        } else if section == "compat.cursor" {
            if let Some(value) = kv(line, "mcps") {
                cursor_on = value == "true";
            }
        }
    }
    if let Some(done) = current {
        servers.push(done);
    }
    (servers, claude_on, cursor_on)
}

fn parse_mcp_json(text: &str) -> Option<Vec<RawServer>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.get("mcpServers")?.as_object()?;
    Some(
        object
            .iter()
            .filter_map(|(name, spec)| {
                let spec = spec.as_object()?;
                Some(RawServer {
                    name: name.clone(),
                    command: spec
                        .get("command")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    url: spec
                        .get("url")
                        .or_else(|| spec.get("serverUrl"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                })
            })
            .collect(),
    )
}

fn mcp_server_name(header: &str) -> Option<String> {
    let rest = header.strip_prefix("mcp_servers.")?;
    let name = if rest.starts_with('"') {
        rest.trim_matches('"')
    } else {
        rest.split('.').next().unwrap_or("")
    };
    (!name.is_empty()).then(|| name.to_string())
}

fn kv(line: &str, key: &str) -> Option<String> {
    let (left, right) = line.split_once('=')?;
    (left.trim() == key).then(|| {
        right
            .trim()
            .trim_end_matches(',')
            .trim_matches(|c: char| c == '"' || c == '\'')
            .to_string()
    })
}

fn url_detail(raw: &str) -> String {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://").unwrap_or(("https", raw));
    let rest = rest.rsplit_once('@').map(|(_, host)| host).unwrap_or(rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if host.is_empty() {
        scheme.to_string()
    } else {
        format!("{scheme}://{host}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const SECRET: &str = "sk-secret-token";

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn parse_local_config_redacts_secrets() {
        let toml = format!(
            "[mcp_servers.filesystem]\ncommand = \"npx\"\nargs = [\"{SECRET}\"]\n\
             [mcp_servers.linear]\nurl = \"https://user:{SECRET}@mcp.linear.app/mcp?x={SECRET}\"\n\
             [mcp_servers.\"my-tools\"]\ncommand = \"uvx\"\n"
        );
        let (rows, claude_on, _) = parse_grok_config_toml(&toml);
        assert!(claude_on);
        assert_eq!(rows[0].command.as_deref(), Some("npx"));
        assert_eq!(
            url_detail(rows[1].url.as_deref().unwrap()),
            "https://mcp.linear.app"
        );
        assert_eq!(rows[2].name, "my-tools");
        let mut listed = Vec::new();
        add(&mut listed, rows, "cfg", "user", false);
        let json = serde_json::to_string(&listed).unwrap();
        assert!(!json.contains(SECRET));
        assert_eq!(
            parse_mcp_json(&format!(
                r#"{{"mcpServers":{{"github":{{"command":"npx","env":{{"TOKEN":"{SECRET}"}}}}}}}}"#
            ))
            .unwrap()[0]
                .name,
            "github"
        );
        assert!(!parse_grok_config_toml("[compat.claude]\nmcps = false\n").1);
    }

    #[test]
    fn untrusted_folder_holds_project_mcp_off() {
        let root = TempDir::new().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("proj");
        write(
            &home.join(".grok").join("config.toml"),
            "[mcp_servers.userfs]\ncommand = \"npx\"\n",
        );
        write(
            &project.join(".mcp.json"),
            r#"{"mcpServers":{"evil":{"url":"https://evil.example/mcp?x=1"}}}"#,
        );
        let held = collect_mcp_visibility(&home, Some((&project, false)));
        assert!(!held.iter().find(|s| s.name == "userfs").unwrap().held_off);
        let evil = held.iter().find(|s| s.name == "evil").unwrap();
        assert!(evil.held_off && evil.detail == "https://evil.example");
        assert!(collect_mcp_visibility(&home, Some((&project, true)))
            .iter()
            .any(|s| s.name == "evil" && !s.held_off));
    }

    #[test]
    fn module_does_not_spawn_or_fetch() {
        let src = include_str!("mcp.rs");
        assert!(!src.contains(&["std", "process"].join("::")));
        assert!(!src.contains(&["Command", "new"].join("::")));
    }
}
