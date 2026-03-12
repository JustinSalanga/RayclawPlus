use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::json;
use tracing::info;

use crate::config::WorkingDirIsolation;
use crate::llm_types::ToolDefinition;

use super::{resolve_tool_path, resolve_tool_working_dir, schema_object, Tool, ToolResult};

pub struct ZipTool {
    working_dir: PathBuf,
    working_dir_isolation: WorkingDirIsolation,
}

impl ZipTool {
    pub fn new_with_isolation(working_dir: &str, working_dir_isolation: WorkingDirIsolation) -> Self {
        Self {
            working_dir: PathBuf::from(working_dir),
            working_dir_isolation,
        }
    }
}

#[async_trait]
impl Tool for ZipTool {
    fn name(&self) -> &str {
        "zip"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "zip".into(),
            description: "Create a .zip archive from one or more files or directories.".into(),
            input_schema: schema_object(
                json!({
                    "sources": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "description": "List of files or directories to include in the archive (relative to working dir or absolute)."
                    },
                    "destination": {
                        "type": "string",
                        "description": "Path for the output .zip file."
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description": "Whether to overwrite an existing destination file (default: false)."
                    }
                }),
                &["sources", "destination"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let Some(sources_val) = input.get("sources") else {
            return ToolResult::error("Missing 'sources' parameter".into());
        };
        let Some(dest_str) = input.get("destination").and_then(|v| v.as_str()) else {
            return ToolResult::error("Missing 'destination' parameter".into());
        };
        let overwrite = input
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let working_dir =
            resolve_tool_working_dir(&self.working_dir, self.working_dir_isolation, &input);
        let dest_path = resolve_tool_path(&working_dir, dest_str);
        let dest_path_str = dest_path.to_string_lossy().to_string();

        if let Err(msg) = crate::tools::path_guard::check_path(&dest_path_str) {
            return ToolResult::error(msg);
        }

        if dest_path.exists() && !overwrite {
            return ToolResult::error(format!(
                "Destination '{}' already exists and 'overwrite' is false.",
                dest_path.display()
            ));
        }

        // Collect source paths
        let mut source_paths: Vec<PathBuf> = Vec::new();
        if let Some(arr) = sources_val.as_array() {
            for v in arr {
                let Some(s) = v.as_str() else {
                    return ToolResult::error("Each entry in 'sources' must be a string path.".into());
                };
                let resolved = resolve_tool_path(&working_dir, s);
                let resolved_str = resolved.to_string_lossy().to_string();
                if let Err(msg) = crate::tools::path_guard::check_path(&resolved_str) {
                    return ToolResult::error(msg);
                }
                source_paths.push(resolved);
            }
        } else {
            return ToolResult::error("'sources' must be an array of paths.".into());
        }

        info!("Creating zip archive: {}", dest_path.display());

        let join_result =
            tokio::task::spawn_blocking(move || zip_blocking(&source_paths, &dest_path)).await;

        let result = match join_result {
            Ok(inner) => inner,
            Err(e) => {
                return ToolResult::error(format!("zip task join error: {e}"));
            }
        };

        match result {
            Ok(stats) => ToolResult::success(format!(
                "Created archive '{}': {} entries, {} bytes written.",
                dest_path_str, stats.entries, stats.bytes
            )),
            Err(msg) => ToolResult::error(msg),
        }
    }
}

struct ZipStats {
    entries: usize,
    bytes: u64,
}

fn zip_blocking(sources: &[PathBuf], dest: &Path) -> Result<ZipStats, String> {
    use walkdir::WalkDir;
    use zip::write::FileOptions;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directories: {e}"))?;
    }

    let file = File::create(dest).map_err(|e| format!("Failed to create archive file: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut entries = 0usize;
    let mut total_bytes = 0u64;

    for src in sources {
        if src.is_dir() {
            for entry in WalkDir::new(src) {
                let entry = entry.map_err(|e| format!("WalkDir error: {e}"))?;
                let path = entry.path();
                let rel = path
                    .strip_prefix(src)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel.is_empty() {
                    continue;
                }
                let name = format!(
                    "{}/{}",
                    src.file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(""),
                    rel
                );
                if path.is_dir() {
                    let dir_name = if name.ends_with('/') { name } else { format!("{}/", name) };
                    zip.add_directory(dir_name, options)
                        .map_err(|e| format!("Failed to add directory to archive: {e}"))?;
                } else {
                    add_file_to_zip(&mut zip, path, &name, options, &mut entries, &mut total_bytes)?;
                }
            }
        } else if src.is_file() {
            let name = src
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("file")
                .to_string();
            add_file_to_zip(&mut zip, src, &name, options, &mut entries, &mut total_bytes)?;
        } else {
            return Err(format!("Source '{}' does not exist.", src.display()));
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize archive: {e}"))?;

    Ok(ZipStats {
        entries,
        bytes: total_bytes,
    })
}

fn add_file_to_zip(
    zip: &mut zip::ZipWriter<File>,
    path: &Path,
    name: &str,
    options: zip::write::FileOptions,
    entries: &mut usize,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let mut f = File::open(path)
        .map_err(|e| format!("Failed to open source file '{}': {e}", path.display()))?;
    zip.start_file(name.replace('\\', "/"), options)
        .map_err(|e| format!("Failed to start file '{}' in archive: {e}", name))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read source file '{}': {e}", path.display()))?;
    zip.write_all(&buf)
        .map_err(|e| format!("Failed to write '{}' to archive: {e}", name))?;
    *entries += 1;
    *total_bytes += buf.len() as u64;
    Ok(())
}

pub struct UnzipTool {
    working_dir: PathBuf,
    working_dir_isolation: WorkingDirIsolation,
}

impl UnzipTool {
    pub fn new_with_isolation(
        working_dir: &str,
        working_dir_isolation: WorkingDirIsolation,
    ) -> Self {
        Self {
            working_dir: PathBuf::from(working_dir),
            working_dir_isolation,
        }
    }
}

#[async_trait]
impl Tool for UnzipTool {
    fn name(&self) -> &str {
        "unzip"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "unzip".into(),
            description:
                "Extract a .zip archive into a target directory. Creates the directory if needed."
                    .into(),
            input_schema: schema_object(
                json!({
                    "archive": {
                        "type": "string",
                        "description": "Path to the .zip archive to extract."
                    },
                    "destination": {
                        "type": "string",
                        "description": "Directory to extract into. Will be created if it doesn't exist."
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description": "Whether to overwrite existing files (default: true)."
                    }
                }),
                &["archive", "destination"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let Some(archive_str) = input.get("archive").and_then(|v| v.as_str()) else {
            return ToolResult::error("Missing 'archive' parameter".into());
        };
        let Some(dest_str) = input.get("destination").and_then(|v| v.as_str()) else {
            return ToolResult::error("Missing 'destination' parameter".into());
        };
        let overwrite = input
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let working_dir =
            resolve_tool_working_dir(&self.working_dir, self.working_dir_isolation, &input);
        let archive_path = resolve_tool_path(&working_dir, archive_str);
        let dest_path = resolve_tool_path(&working_dir, dest_str);

        let archive_str_full = archive_path.to_string_lossy().to_string();
        let dest_str_full = dest_path.to_string_lossy().to_string();

        if let Err(msg) = crate::tools::path_guard::check_path(&archive_str_full) {
            return ToolResult::error(msg);
        }
        if let Err(msg) = crate::tools::path_guard::check_path(&dest_str_full) {
            return ToolResult::error(msg);
        }

        info!(
            "Extracting archive '{}' into '{}'",
            archive_path.display(),
            dest_path.display()
        );

        let join_result = tokio::task::spawn_blocking(move || {
            unzip_blocking(&archive_path, &dest_path, overwrite)
        })
        .await;

        let result = match join_result {
            Ok(inner) => inner,
            Err(e) => {
                return ToolResult::error(format!("unzip task join error: {e}"));
            }
        };

        match result {
            Ok(stats) => ToolResult::success(format!(
                "Extracted archive '{}' into '{}': {} entries.",
                archive_str_full, dest_str_full, stats.entries
            )),
            Err(msg) => ToolResult::error(msg),
        }
    }
}

struct UnzipStats {
    entries: usize,
}

fn unzip_blocking(archive: &Path, dest: &Path, overwrite: bool) -> Result<UnzipStats, String> {
    let file = File::open(archive)
        .map_err(|e| format!("Failed to open archive '{}': {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read archive '{}': {e}", archive.display()))?;

    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create destination '{}': {e}", dest.display()))?;

    let mut entries = 0usize;

    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|e| format!("Failed to access entry {i} in archive: {e}"))?;
        let name = file.name().replace('\\', "/");
        let out_path = dest.join(&name);

        // Basic protection: avoid writing outside dest via ../
        if let Ok(canonical_dest) = dest.canonicalize() {
            if let Some(parent) = out_path.parent() {
                if let Ok(canonical_out_parent) = parent.canonicalize() {
                    if !canonical_out_parent.starts_with(&canonical_dest) {
                        return Err(format!(
                            "Refusing to extract entry '{}' outside destination directory.",
                            name
                        ));
                    }
                }
            }
        }

        if file.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| {
                format!(
                    "Failed to create directory '{}' while extracting: {e}",
                    out_path.display()
                )
            })?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create parent directory '{}' while extracting: {e}",
                        parent.display()
                    )
                })?;
            }
            if out_path.exists() && !overwrite {
                continue;
            }
            let mut outfile = File::create(&out_path).map_err(|e| {
                format!(
                    "Failed to create output file '{}' while extracting: {e}",
                    out_path.display()
                )
            })?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| {
                format!(
                    "Failed to write '{}' while extracting: {e}",
                    out_path.display()
                )
            })?;
        }
        entries += 1;
    }

    Ok(UnzipStats { entries })
}

