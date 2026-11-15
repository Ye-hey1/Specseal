//! remote runtime 的 token 生命周期（design 决策 4「token 生命周期与 401 语意」；
//! 规格「token 换发全程 Rust 侧且 401 语意固定」）。
//!
//! per-connection TokenManager：bearer（access token 或 PAT）只在 Rust 内存；
//! 请求前无 bearer 即以 Keychain refresh credential 换发（rotation 新 refresh
//! credential 由 refresh_connection 立即回写）、无 refresh credential 则以 PAT
//! 为 bearer；任何请求 401 → 换发一次 → 重试一次 → 仍 401 即进入 needs-reauth
//! 状态——TS 只见布尔与繁中消息，后续操作直接回拒绝错误、不再打 server。
//! access token 的过期采反应式 401 路径处理（规格「过期自动换发、用户无感」
//! 的可观察契约相同），不另外追踪 expires_in。

use crate::connections::RefreshFailure;
use specseal_remote::credentials::{CredentialKind, CredentialStore};
use serde::Serialize;
use specseal_core::model::{require_valid_meta, ChangeMeta, LEGACY_META_FILE, META_FILE};
use specseal_core::workspace::{Workspace, DEFAULT_SPEC_DIR, LEGACY_SPEC_DIR};
use specseal_core::store::Store;
use specseal_desktop_core::settings::{
    read_workflow_settings_from_text, rewrite_workflow_content_text, rewrite_workflow_fields_text,
    AppSettings, ContentEdit, WorkflowPolicyFields, WorkflowSettings,
};
use specseal_protocol::binding::BindingResponse;
use specseal_protocol::command::{
    ArchiveDiscussionResponse, ArchiveResponse, ClaimResponse, PromoteDiscussionResponse,
    ReviewTicketResponse,
};
use specseal_protocol::events::TransportKind;
use specseal_protocol::query::{
    ArchivedItem, ArtifactContent, BoardOrderDoc, ChangeStatus, ChangeSummary,
    DiscussionCut, DiscussionInfo, ImportBundle, ImportBundleDocument, ImportDocumentId,
    ImportReportResponse, ImportScope, ListSpecsResponse, PlanChangeEntry, PlanResponse,
    PlanUnpromotedCut, ScopesResponse, SearchResponse, ShowDiscussionResponse, SpecDocumentResponse,
    StationOutcome, StationState,
};
use specseal_core::model::ReviewedScopeEntry;
use specseal_core::station::{ArchivedOutcome, Station, StationId, REVIEW, VERIFY};
use specseal_desktop_core::query::{archived_status_str, put_station_fields, station_view, StationView};
use specseal_core::config::AppConfig;
use specseal_core::init::ToolSelection;
use specseal_protocol::skills::{SkillsRequest, SkillsResponse};
use specseal_remote::client::Client;
use specseal_remote::skills as remote_skills;
use specseal_remote::RemoteError;
use specseal_store::content_digest;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// needs-reauth 的繁中状态消息（完整重新认证 UX 属后续刀，本刀只回报状态）。
const REAUTH_MESSAGE: &str = "此连接的登录已失效——请重新登录";
const OFFLINE_MESSAGE: &str = "此连接目前脱机——显示最后成功加载的内容";
const OFFLINE_WRITE_MESSAGE: &str = "此连接目前脱机——写入已拒绝，未排队或暂存";
pub const REMOTE_CONNECTION_STATE_EVENT: &str = "remote-connection-state";
pub const DEFAULT_FAILURE_THRESHOLD: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionState {
    Online,
    Offline,
    NeedsReauth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStateEvent {
    pub connection_id: String,
    pub state: ConnectionState,
    pub message: Option<String>,
}

/// `remote_open` 专用的 IPC failure shape。只公开复原分类需要的字段，
/// credential、header 与 Keychain 内容都不跨越 Tauri 边界。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOpenFailure {
    pub message: String,
    pub reason: Option<String>,
    pub status: Option<u16>,
}

impl RemoteOpenFailure {
    pub fn unknown(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reason: None,
            status: None,
        }
    }
}

impl From<RemoteError> for RemoteOpenFailure {
    fn from(error: RemoteError) -> Self {
        Self {
            message: error.message,
            reason: error.reason,
            status: error.status,
        }
    }
}

struct ConnectionHealth {
    connection_id: Option<String>,
    state: ConnectionState,
    consecutive_failures: usize,
}

/// 一条 connection 的 token 生命周期管理者。
pub struct TokenManager {
    origin: String,
    /// 内存持有的 bearer；绝不落盘、绝不过境 TS。
    bearer: Mutex<Option<String>>,
    /// 同一 connection 的 credential 取得／轮替 singleflight。
    rotation: Mutex<()>,
    /// needs-reauth 状态消息；Some 之后所有操作直接拒绝。
    needs_reauth: Mutex<Option<String>>,
    health: Mutex<ConnectionHealth>,
    failure_threshold: usize,
    state_observer: Arc<dyn Fn(ConnectionStateEvent) + Send + Sync>,
}

impl TokenManager {
    pub fn new(origin: &str) -> TokenManager {
        Self::with_state_observer(origin, DEFAULT_FAILURE_THRESHOLD, |_| {})
    }

    pub fn with_connection_state(
        origin: &str,
        connection_id: &str,
        failure_threshold: usize,
        observer: impl Fn(ConnectionStateEvent) + Send + Sync + 'static,
    ) -> TokenManager {
        let manager = Self::with_state_observer(origin, failure_threshold, observer);
        manager.bind_connection_id(connection_id);
        manager
    }

    pub(crate) fn with_state_observer(
        origin: &str,
        failure_threshold: usize,
        observer: impl Fn(ConnectionStateEvent) + Send + Sync + 'static,
    ) -> TokenManager {
        TokenManager {
            origin: origin.to_string(),
            bearer: Mutex::new(None),
            rotation: Mutex::new(()),
            needs_reauth: Mutex::new(None),
            health: Mutex::new(ConnectionHealth {
                connection_id: None,
                state: ConnectionState::Online,
                consecutive_failures: 0,
            }),
            failure_threshold: failure_threshold.max(1),
            state_observer: Arc::new(observer),
        }
    }

    pub fn bind_connection_id(&self, connection_id: &str) {
        self.health.lock().expect("health lock").connection_id = Some(connection_id.to_string());
    }

    /// 登录流程换得的 access token 交接进来；重新登录即复原 needs-reauth。
    pub fn adopt_access_token(&self, token: &str) {
        *self.bearer.lock().expect("bearer lock") = Some(token.to_string());
        *self.needs_reauth.lock().expect("reauth lock") = None;
        self.transition_online();
    }

    /// TS 可查的连接状态：Some(繁中消息)＝需重新认证。
    pub fn needs_reauth(&self) -> Option<String> {
        self.needs_reauth.lock().expect("reauth lock").clone()
    }

    pub fn connection_state(&self) -> ConnectionState {
        self.health.lock().expect("health lock").state
    }

    /// 以有效 bearer 运行一次请求（调用端逐请求建构 specseal-remote Client）：
    /// 请求前自动换发、401 → 换发一次 → 重试一次 → 仍 401 即 needs-reauth。
    pub fn execute<T>(
        &self,
        credentials: &dyn CredentialStore,
        call: impl Fn(&str) -> Result<T, RemoteError>,
    ) -> Result<T, RemoteError> {
        if self.needs_reauth().is_some() {
            return Err(rejected());
        }
        let bearer = match self.acquire(credentials) {
            Ok(bearer) => bearer,
            Err(error) => return self.observe_result(Err(error)),
        };
        match call(&bearer) {
            Err(e) if e.status == Some(401) => {
                // 缓存的 bearer 已死：换发后恰好重试一次。PAT 连接无可换发，
                // mint 会交回同一枚 PAT，重试再 401 即进 needs-reauth。
                let fresh = match self.recover_after_unauthorized(credentials, &bearer) {
                    Ok(fresh) => fresh,
                    Err(error) => return self.observe_result(Err(error)),
                };
                match call(&fresh) {
                    Err(e) if e.status == Some(401) => Err(self.flag_reauth()),
                    other => self.observe_result(other),
                }
            }
            other => self.observe_result(other),
        }
    }

    pub fn execute_write<T>(
        &self,
        credentials: &dyn CredentialStore,
        call: impl Fn(&str) -> Result<T, RemoteError>,
    ) -> Result<T, RemoteError> {
        self.ensure_write_allowed()?;
        self.execute(credentials, call)
    }

    fn ensure_write_allowed(&self) -> Result<(), RemoteError> {
        match self.connection_state() {
            ConnectionState::Online => Ok(()),
            ConnectionState::Offline => Err(offline_rejected()),
            ConnectionState::NeedsReauth => Err(rejected()),
        }
    }

    fn observe_result<T>(&self, result: Result<T, RemoteError>) -> Result<T, RemoteError> {
        match result {
            Ok(value) => {
                self.record_success();
                Ok(value)
            }
            Err(error) => {
                if is_transport_failure(&error) {
                    self.record_transport_failure();
                }
                Err(error)
            }
        }
    }

    fn record_success(&self) {
        let event = {
            let mut health = self.health.lock().expect("health lock");
            health.consecutive_failures = 0;
            if health.state == ConnectionState::Offline {
                health.state = ConnectionState::Online;
                health
                    .connection_id
                    .clone()
                    .map(|connection_id| ConnectionStateEvent {
                        connection_id,
                        state: ConnectionState::Online,
                        message: None,
                    })
            } else {
                None
            }
        };
        self.emit_state(event);
    }

    fn record_transport_failure(&self) {
        let event = {
            let mut health = self.health.lock().expect("health lock");
            if health.state == ConnectionState::NeedsReauth {
                return;
            }
            health.consecutive_failures = health.consecutive_failures.saturating_add(1);
            if health.consecutive_failures >= self.failure_threshold
                && health.state != ConnectionState::Offline
            {
                health.state = ConnectionState::Offline;
                health
                    .connection_id
                    .clone()
                    .map(|connection_id| ConnectionStateEvent {
                        connection_id,
                        state: ConnectionState::Offline,
                        message: Some(OFFLINE_MESSAGE.to_string()),
                    })
            } else {
                None
            }
        };
        self.emit_state(event);
    }

    fn transition_online(&self) {
        let event = {
            let mut health = self.health.lock().expect("health lock");
            health.consecutive_failures = 0;
            if health.state != ConnectionState::Online {
                health.state = ConnectionState::Online;
                health
                    .connection_id
                    .clone()
                    .map(|connection_id| ConnectionStateEvent {
                        connection_id,
                        state: ConnectionState::Online,
                        message: None,
                    })
            } else {
                None
            }
        };
        self.emit_state(event);
    }

    fn transition_needs_reauth(&self) {
        let event = {
            let mut health = self.health.lock().expect("health lock");
            health.consecutive_failures = 0;
            if health.state != ConnectionState::NeedsReauth {
                health.state = ConnectionState::NeedsReauth;
                health
                    .connection_id
                    .clone()
                    .map(|connection_id| ConnectionStateEvent {
                        connection_id,
                        state: ConnectionState::NeedsReauth,
                        message: Some(REAUTH_MESSAGE.to_string()),
                    })
            } else {
                None
            }
        };
        self.emit_state(event);
    }

    fn emit_state(&self, event: Option<ConnectionStateEvent>) {
        if let Some(event) = event {
            (self.state_observer)(event);
        }
    }

    /// 请求 bearer：缓存优先，否则换发。
    fn acquire(&self, credentials: &dyn CredentialStore) -> Result<String, RemoteError> {
        if let Some(cached) = self.bearer.lock().expect("bearer lock").clone() {
            return Ok(cached);
        }
        let _rotation = self.rotation.lock().expect("rotation lock");
        if self.needs_reauth().is_some() {
            return Err(rejected());
        }
        if let Some(cached) = self.bearer.lock().expect("bearer lock").clone() {
            return Ok(cached);
        }
        self.mint(credentials)
    }

    /// 401 后只允许一个 caller 轮替；等待者若看到已发布且不同于自己被拒的
    /// bearer，直接复用先行者结果，不得清掉新 token 再消耗 refresh。
    fn recover_after_unauthorized(
        &self,
        credentials: &dyn CredentialStore,
        rejected_bearer: &str,
    ) -> Result<String, RemoteError> {
        let _rotation = self.rotation.lock().expect("rotation lock");
        if self.needs_reauth().is_some() {
            return Err(rejected());
        }
        if let Some(current) = self.bearer.lock().expect("bearer lock").clone() {
            if current != rejected_bearer {
                return Ok(current);
            }
        }
        *self.bearer.lock().expect("bearer lock") = None;
        // 被拒的 bearer 也躺在共用缓存里——不清掉的话下一步会原样捡回来。
        specseal_remote::refresh::clear_cached_bearer(&self.origin, credentials);
        self.mint(credentials)
    }

    /// 内存无 bearer 时取得一个：共用的 access token 缓存（CLI 可能刚换发过）
    /// → refresh credential 换发（持跨行程锁，回写在下沉层）→ PAT → 皆无即
    /// needs-reauth。Unavailable（5xx／不可达／Keychain 故障）是暂时性错误、
    /// 不进 needs-reauth——与登录编排同一原则：暂时性失败不是 credential 失效
    /// 的语意信号。
    fn mint(&self, credentials: &dyn CredentialStore) -> Result<String, RemoteError> {
        let has_refresh = credentials
            .get(&self.origin, CredentialKind::Refresh)
            .map_err(unavailable)?
            .is_some();
        let bearer = if has_refresh {
            match specseal_remote::refresh::bearer_for(
                &self.origin,
                credentials,
                &specseal_remote::auth::specseal_config_dir(),
            ) {
                Ok(access) => access,
                Err(RefreshFailure::Rejected(_)) => return Err(self.flag_reauth()),
                Err(RefreshFailure::Unavailable(message)) => return Err(unavailable(message)),
            }
        } else {
            match credentials
                .get(&self.origin, CredentialKind::Pat)
                .map_err(unavailable)?
            {
                Some(pat) => pat,
                None => return Err(self.flag_reauth()),
            }
        };
        *self.bearer.lock().expect("bearer lock") = Some(bearer.clone());
        Ok(bearer)
    }

    /// 进入 needs-reauth：丢弃内存 bearer、记下状态，回拒绝错误。
    fn flag_reauth(&self) -> RemoteError {
        *self.bearer.lock().expect("bearer lock") = None;
        *self.needs_reauth.lock().expect("reauth lock") = Some(REAUTH_MESSAGE.to_string());
        self.transition_needs_reauth();
        rejected()
    }
}

fn is_transport_failure(error: &RemoteError) -> bool {
    error.status.is_none()
        && error.reason.is_none()
        && error.message.starts_with("server unreachable")
}

/// needs-reauth 的拒绝错误：繁中消息＋机读 reason。
fn rejected() -> RemoteError {
    RemoteError {
        message: REAUTH_MESSAGE.to_string(),
        reason: Some("needs_reauth".to_string()),
        status: None,
        evidence: None,
    }
}

fn offline_rejected() -> RemoteError {
    RemoteError {
        message: OFFLINE_WRITE_MESSAGE.to_string(),
        reason: Some("offline".to_string()),
        status: None,
        evidence: None,
    }
}

/// 暂时性失败原样中继（消息来自 refresh 编排或 Keychain）。
fn unavailable(message: String) -> RemoteError {
    RemoteError {
        message,
        reason: None,
        status: None,
        evidence: None,
    }
}

/// SpecsealDataSource 的 artifact 寻址是文件名（proposal.md、tasks.md、
/// specs/{cap}/spec.md），server 端点吃 artifact id（proposal、tasks、
/// specs/{cap}）——此处单点范式，缺席才会是 404 而非 400。
fn artifact_id(artifact: &str) -> &str {
    if let Some(cap_dir) = artifact.strip_suffix("/spec.md") {
        return cap_dir;
    }
    artifact.strip_suffix(".md").unwrap_or(artifact)
}

/// Read one local filesystem workspace through the Engine Store seam and
/// produce the migration wire bundle. Every source is read before upload; any
/// corrupt metadata or unsupported artifact pattern aborts the whole build.
pub fn build_import_bundle(root: &Path, project: &str, repo: &str) -> Result<ImportBundle, String> {
    if project.trim().is_empty() || repo.trim().is_empty() {
        return Err("migration target project and repo must both be selected".to_string());
    }
    let context = specseal_desktop_core::init_core_context(root)
        .ok_or_else(|| format!("not a local specseal workspace: {}", root.display()))?;
    let store: &dyn Store = &context.store;
    let user_dir = specseal_host::context::global_config_dir();
    let mut documents = BTreeMap::<ImportDocumentId, String>::new();

    for change in store.list_changes() {
        require_valid_meta(store, &change).map_err(|error| error.to_string())?;
        let meta = store.read_change_meta(&change.name).unwrap_or_default();
        insert_import_document(
            &mut documents,
            ImportDocumentId::ChangeMeta {
                change: change.name.clone(),
            },
            meta,
        )?;
        let schema =
            resolve_migration_schema(&context.workspace, &user_dir, &change.meta.schema_name())?;
        for artifact in migration_artifact_paths(&schema, store.delta_capabilities(&change.name))? {
            if let Some(content) = store.read_artifact(&change.name, &artifact) {
                insert_import_document(
                    &mut documents,
                    ImportDocumentId::ChangeArtifact {
                        change: change.name.clone(),
                        artifact,
                    },
                    content,
                )?;
            }
        }
    }

    let mut capabilities = store.list_canonical_capabilities();
    capabilities.sort();
    for capability in capabilities {
        if let Some(content) = store.read_canonical_spec(&capability) {
            insert_import_document(
                &mut documents,
                ImportDocumentId::CanonicalSpec { capability },
                content,
            )?;
        }
    }

    for discussion in store.list_live_discussions() {
        insert_import_document(
            &mut documents,
            ImportDocumentId::Discussion {
                slug: discussion.slug,
                archived: false,
            },
            discussion.text,
        )?;
    }
    for discussion in store.list_archived_discussions() {
        insert_import_document(
            &mut documents,
            ImportDocumentId::Discussion {
                slug: discussion.slug,
                archived: true,
            },
            discussion.text,
        )?;
    }

    for dated_name in store.list_archived_changes() {
        let meta = store.read_archived_meta(&dated_name).unwrap_or_default();
        let parsed = ChangeMeta::from_text(Some(&meta)).map_err(|reason| {
            // 读取先新后旧：新文件名不在时，坏的是旧文件名那份。
            let dir = format!("{}/changes/archive/{dated_name}", context.workspace.spec_dir_name);
            let file = if context.workspace.root.join(&dir).join(META_FILE).is_file() {
                META_FILE
            } else {
                LEGACY_META_FILE
            };
            format!("invalid {dir}/{file}: {reason}")
        })?;
        // 读取先新后旧，上传一律以 .meta.yaml 为键（desktop-spec-dir-migration D5）。
        insert_import_document(
            &mut documents,
            ImportDocumentId::ArchivedChange {
                change: dated_name.clone(),
                doc: META_FILE.to_string(),
            },
            meta,
        )?;
        let schema =
            resolve_migration_schema(&context.workspace, &user_dir, &parsed.schema_name())?;
        for artifact in
            migration_artifact_paths(&schema, store.archived_delta_capabilities(&dated_name))?
        {
            if let Some(content) = store.read_archived_artifact(&dated_name, &artifact) {
                insert_import_document(
                    &mut documents,
                    ImportDocumentId::ArchivedChange {
                        change: dated_name.clone(),
                        doc: artifact,
                    },
                    content,
                )?;
            }
        }
    }

    if let Some(content) = store.read_workflow_config() {
        insert_import_document(&mut documents, ImportDocumentId::WorkflowConfig, content)?;
    }
    if let Some(content) = store.read_language() {
        insert_import_document(&mut documents, ImportDocumentId::Language, content)?;
    }

    Ok(ImportBundle {
        format_version: specseal_store::BUNDLE_FORMAT_VERSION,
        scope: ImportScope {
            project: project.to_string(),
            repo: repo.to_string(),
        },
        project_revision: 0,
        documents: documents
            .into_iter()
            .map(|(document, content)| ImportBundleDocument {
                digest: content_digest(&content),
                document,
                content,
            })
            .collect(),
    })
}

fn resolve_migration_schema(
    workspace: &specseal_core::workspace::Workspace,
    user_dir: &Path,
    name: &str,
) -> Result<specseal_core::schema::Schema, String> {
    specseal_core::schema::resolve_with(Some(workspace), Some(user_dir), name)
        .ok_or_else(|| specseal_core::schema::not_found_msg(name))?
}

fn migration_artifact_paths(
    schema: &specseal_core::schema::Schema,
    delta_capabilities: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    for artifact in &schema.artifacts {
        if artifact.output_path == "specs/**/*.md" {
            paths.extend(
                delta_capabilities
                    .iter()
                    .map(|capability| format!("specs/{capability}/spec.md")),
            );
        } else if artifact.output_path.contains('*') {
            return Err(format!(
                "cannot enumerate migration artifact pattern '{}' in schema '{}'",
                artifact.output_path, schema.name
            ));
        } else {
            paths.insert(artifact.output_path.clone());
        }
    }
    Ok(paths.into_iter().collect())
}

fn insert_import_document(
    documents: &mut BTreeMap<ImportDocumentId, String>,
    document: ImportDocumentId,
    content: String,
) -> Result<(), String> {
    if documents.insert(document.clone(), content).is_some() {
        return Err(format!("duplicate local migration document: {document:?}"));
    }
    Ok(())
}

/// Successful local-to-remote conversion. The UI uses `checkoutRoot` to replace
/// the local tab in place and displays the retained backup path.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub report: ImportReportResponse,
    pub backup_path: String,
    pub checkout_root: String,
}

/// Result of resolving a coexistence conflict in favor of server truth. This
/// path never builds or uploads a Bundle; it only retains the local tree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAdoptionResult {
    pub backup_path: String,
    pub checkout_root: String,
}

/// The spec folder a local-to-remote move works on: the default `specseal/` or
/// the legacy `openspec/`. An explicit custom `spec_dir` is refused before any
/// remote write (desktop-spec-dir-migration D5).
fn migratable_spec_dir(workspace: &Workspace, action: &str) -> Result<String, String> {
    let name = &workspace.spec_dir_name;
    if name != DEFAULT_SPEC_DIR && name != LEGACY_SPEC_DIR {
        return Err(format!(
            "{action} requires the default spec folder (specseal/ or openspec/); this workspace uses {name}/"
        ));
    }
    // 只备份其中一个会留下另一个：转成 checkout 后一开就是本机与远程并存。
    let other = if name == DEFAULT_SPEC_DIR { LEGACY_SPEC_DIR } else { DEFAULT_SPEC_DIR };
    let other_dir = workspace.root.join(other);
    let coexists = if other == LEGACY_SPEC_DIR {
        other_dir.is_dir()
    } else {
        specseal_core::workspace::is_spec_folder(&other_dir)
    };
    if coexists {
        return Err(format!(
            "{action} cannot run while both specseal/ and openspec/ exist — move or remove {other}/ first"
        ));
    }
    Ok(name.clone())
}

/// Bundle and import a local workspace, then—and only then—rename the local
/// spec folder to a dated backup and write the remote marker.
pub fn migrate_workspace(
    root: &Path,
    origin: &str,
    project: &str,
    repo: &str,
    manager: &Arc<TokenManager>,
    credentials: &dyn CredentialStore,
) -> Result<MigrationResult, String> {
    let context = specseal_desktop_core::init_core_context(root)
        .ok_or_else(|| format!("not a local specseal workspace: {}", root.display()))?;
    let folder = migratable_spec_dir(&context.workspace, "local-to-remote migration")?;
    let checkout_root = context.workspace.root;
    let bundle = build_import_bundle(root, project, repo)?;
    let project_base = format!(
        "{}/api/specseal/v1/projects/{project}",
        origin.trim_end_matches('/')
    );
    let report = manager
        .execute_write(credentials, |token| {
            Client::new(&project_base, token, Some(repo)).import(&bundle)
        })
        .map_err(|error| error.message)?;

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let backup_path =
        finalize_local_migration_with(&checkout_root, &folder, origin, project, repo, &date, |from, to| {
            std::fs::rename(from, to)
        })?;
    Ok(MigrationResult {
        report,
        backup_path: backup_path.display().to_string(),
        checkout_root: checkout_root.display().to_string(),
    })
}

/// Retain the local spec folder as a backup and leave the existing remote marker
/// byte-for-byte intact. Used only after the UI has successfully handshaken
/// with the marker's server scope.
pub fn adopt_remote_workspace(root: &Path) -> Result<RemoteAdoptionResult, String> {
    let context = specseal_desktop_core::init_core_context(root)
        .ok_or_else(|| format!("not a local specseal workspace: {}", root.display()))?;
    let folder = migratable_spec_dir(&context.workspace, "adopting server truth")?;
    let checkout_root = context.workspace.root;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let backup_path = adopt_remote_workspace_with(&checkout_root, &folder, &date, |from, to| {
        std::fs::rename(from, to)
    })?;
    Ok(RemoteAdoptionResult {
        backup_path: backup_path.display().to_string(),
        checkout_root: checkout_root.display().to_string(),
    })
}

fn adopt_remote_workspace_with(
    root: &Path,
    folder: &str,
    date: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<std::path::PathBuf, String> {
    let marker = root.join(".specseal.yaml");
    if !marker.is_file() {
        return Err(format!(
            "cannot adopt server truth without an existing remote marker: {}",
            marker.display()
        ));
    }
    let source = root.join(folder);
    let backup = next_migration_backup(root, folder, date);
    rename(&source, &backup).map_err(|error| {
        format!(
            "server content was verified but the local backup rename failed ({error}). Local {folder}/ remains intact; no upload or server write was attempted. Rename '{}' to '{}' manually before reopening the checkout.",
            source.display(),
            backup.display()
        )
    })?;
    Ok(backup)
}

fn finalize_local_migration_with(
    root: &Path,
    folder: &str,
    origin: &str,
    project: &str,
    repo: &str,
    date: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<std::path::PathBuf, String> {
    let source = root.join(folder);
    let backup = next_migration_backup(root, folder, date);
    rename(&source, &backup).map_err(|error| {
        format!(
            "server import succeeded, but the local backup rename failed ({error}). Local {folder}/ remains intact and no remote marker was written. Rename '{}' to '{}' manually, then reconnect this folder as a checkout; do not retry import into the same scope.",
            source.display(),
            backup.display()
        )
    })?;

    let project_url = format!(
        "{}/api/specseal/v1/projects/{project}",
        origin.trim_end_matches('/')
    );
    specseal_core::config::write_remote_section(root, &project_url, Some(repo)).map_err(|error| {
        format!(
            "server import and local backup succeeded, but the remote marker could not be written ({error}). The backup is retained at '{}'; repair .specseal.yaml before opening this folder as a checkout.",
            backup.display()
        )
    })?;
    Ok(backup)
}

/// `<folder>.migrated-<date>`, or the first free `-2`, `-3`, … after it.
fn next_migration_backup(root: &Path, folder: &str, date: &str) -> std::path::PathBuf {
    let base = format!("{folder}.migrated-{date}");
    let first = root.join(&base);
    if !first.exists() {
        return first;
    }
    let mut sequence = 2_u64;
    loop {
        let candidate = root.join(format!("{base}-{sequence}"));
        if !candidate.exists() {
            return candidate;
        }
        sequence += 1;
    }
}

// --- handshake 与数据面三类矩阵（决策 1、2、6） ---

/// (c) 类操作的拒绝错误（决策 1 冻结原则：server 缺什么就停用什么，不在
/// client 伪造）。TS RemoteDataSource 与任何误达 Rust 层的调用共用此语意。
pub fn unsupported(operation: &str) -> RemoteError {
    RemoteError {
        message: format!("此 server 尚未提供「{operation}」——功能已停用"),
        reason: Some("unsupported".to_string()),
        status: None,
        evidence: None,
    }
}

// --- 看板顺序 overlay 与拖排写回（remote-board-order） ---
//
// board resource 的内容形状与宽松解析（坏内容＝全员缺 rank）是 protocol 的
// `BoardOrderDoc::from_content`——server 的 plan 端点读 rank 用同一份
// （add-change-plan-remote D1）。

/// 桌面 remote 清单的一项（add-change-plan-remote D5）：server 的 ChangeSummary
/// 原样摊平，再摊平 plan 那一列的调度字段——plan 不可得或成环时整组缺席。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteChangeItem {
    #[serde(flatten)]
    pub summary: ChangeSummary,
    /// 由 [`schedule_of`] 照 desktop-core 的 `PLAN_FIELDS` 组成（与本机清单同一份键清单）。
    #[serde(flatten)]
    pub schedule: Option<serde_json::Map<String, serde_json::Value>>,
    /// 审查与验证的状态字段（station-status-and-landing D7）：键与本机清单项相同
    /// （`reviewStatus`、`reviewedAt`、`reviewedBy` 与验证站的同构三键），由 desktop-core
    /// 的同一份四态判定算出。Server 的回应没有关卡字段时是空的——卡片没有标示。
    #[serde(flatten)]
    pub stations: serde_json::Map<String, serde_json::Value>,
}

/// remote 清单项的任务计数：只有总数与完成数，没有写码任务的分组。章的任务锚因此
/// 只比总数（spec desktop-app：tasksTotal 与目前的任务数不同 → 其后有变动）。
fn task_counts(summary: &ChangeSummary) -> specseal_core::tasks::Counts {
    specseal_core::tasks::Counts {
        total: summary.total_tasks,
        complete: summary.completed_tasks,
        remaining: summary.total_tasks.saturating_sub(summary.completed_tasks),
        code_total: 0,
        code_complete: 0,
        code_remaining: 0,
    }
}

/// 一个清单项两个关卡的状态字段，只依在线的事实与任务数（清单不带 scope，也还没有
/// 工作树可读）。没有关卡对象、或 state 是这个用户端不认得的值：那一站没有键。
pub(crate) fn station_fields(summary: &ChangeSummary) -> serde_json::Map<String, serde_json::Value> {
    let counts = task_counts(summary);
    let mut fields = serde_json::Map::new();
    for (st, wire) in [(&REVIEW, &summary.review), (&VERIFY, &summary.verify)] {
        let Some(status) = wire.as_ref().and_then(specseal_remote::convert::station_status) else {
            continue;
        };
        put_station_fields(&mut fields, st, &status, station_view(&status, &counts, None));
    }
    fields
}

/// 清单项的 `st` 这一站是不是「已盖章、任务数相符」：只有这种才值得拿 scope 去比文件。
fn stamp_holds_so_far(summary: &ChangeSummary, st: &Station) -> bool {
    let wire = match st.id {
        StationId::Review => &summary.review,
        StationId::Verify => &summary.verify,
    };
    wire.as_ref()
        .and_then(specseal_remote::convert::station_status)
        .is_some_and(|status| station_view(&status, &task_counts(summary), None) == StationView::Stamped)
}

/// 章记下的 `commit`，如果 checkout 的 HEAD 包含它。commit 是 server 给的外部输入，
/// 先过引擎的形状检查（只收十六进位）才交给 git；checkout 不认得它也算不包含。
fn held_commit(root: &Path, commit: &str) -> Option<String> {
    let commit = specseal_core::model::checked_commit(commit).ok()?;
    specseal_core::util::git(root, &["merge-base", "--is-ancestor", &commit, "HEAD"])?;
    Some(commit)
}

/// `path` 在 checkout 里是不是还停在 `commit` 当时的样子（当时没有、现在也没有也算）。
/// 用 git 的 blob 识别比：现值照 git 存盘时的换行转换算。
fn still_at_commit(root: &Path, commit: &str, path: &str, exists: bool) -> bool {
    let git = |args: &[&str]| specseal_core::util::git(root, args);
    match (exists, git(&["rev-parse", "--verify", "--quiet", &format!("{commit}:{path}")])) {
        (false, None) => true,
        (true, Some(blob)) => git(&["hash-object", "--", path]).is_some_and(|now| now == blob),
        _ => false,
    }
}

/// 章之后 scope 里有没有文件变了（D7）：现值和章的指纹不同，而且也不是章记下的
/// commit 当时的样子。章记的是盖章当下的 HEAD，被审的内容那时可能还没 commit；checkout
/// 的文件若还是那个 commit 的版本，它只是还没拿到被审的内容，不算其后有变动。scope 的
/// 路径是 server 给的外部输入：不是 repo 内相对路径的一律不读，读作有变。
fn changed_since_stamp(root: &Path, commit: &str, scope: &[ReviewedScopeEntry]) -> bool {
    scope.iter().any(|entry| {
        if specseal_core::station::ensure_repo_relative(&entry.path).is_err() {
            return true;
        }
        let current = specseal_core::util::read_bytes_opt(&root.join(&entry.path));
        let reviewed = current
            .as_deref()
            .is_some_and(|bytes| specseal_core::station::content_fingerprint_bytes(bytes) == entry.hash);
        !reviewed && !still_at_commit(root, commit, &entry.path, current.is_some())
    })
}

/// 绑有 checkout 时的第二步（D7）：对任务数相符的已盖章关卡，用单笔回应带来的 scope
/// 比 checkout 里的文件，章之后有变的改成其后有变动（规则见 [`changed_since_stamp`]）。
/// 只有 checkout 的 HEAD 包含章记下的 commit 时才比：章若盖在别的分支或别台机器，checkout
/// 没有可以对照的那一版——这时（以及章没有记下 commit 时）维持只比任务数的结果。
pub(crate) fn refine_with_checkout(
    item: &mut RemoteChangeItem,
    review: Option<&StationState>,
    verify: Option<&StationState>,
    root: &Path,
) {
    let counts = task_counts(&item.summary);
    for (st, wire) in [(&REVIEW, review), (&VERIFY, verify)] {
        if !stamp_holds_so_far(&item.summary, st) {
            continue;
        }
        let Some(status) = wire.and_then(specseal_remote::convert::station_status) else {
            continue;
        };
        // 单笔回应若已不是「已盖章、任务数相符」（清单之后状态变了），照它的状态重写，
        // 不必比文件。
        let mut view = station_view(&status, &counts, None);
        // 章没有任务数就不判内容：引擎的规则（`stale_reason`）如此，本机清单也是。
        let held = status.tasks_total.and(status.commit.as_deref()).and_then(|commit| held_commit(root, commit));
        if let (StationView::Stamped, Some(commit)) = (view, held) {
            if changed_since_stamp(root, &commit, &status.scope) {
                view = StationView::StampedStale;
            }
        }
        put_station_fields(&mut item.stations, st, &status, view);
    }
}

/// 已封存清单的一项：server 的 ArchivedItem 原样摊平，加上与本机同名的结局字段
/// （`reviewStatus`：none／reviewed／reviewedNotPassed；验证站同构）。Server 没有回报
/// 结局、或值是这个用户端不认得的：没有键。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArchivedItem {
    #[serde(flatten)]
    pub item: ArchivedItem,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_status: Option<&'static str>,
}

/// `remote_list_archived` 的 payload。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteArchivedList {
    pub archived: Vec<RemoteArchivedItem>,
}

/// 在线的结局对到已封存卡片读的字符串（字符串表是 desktop-core 的 [`archived_status_str`]，
/// 与本机的封存缓存同一份）。
fn outcome_status(st: &Station, outcome: Option<&StationOutcome>) -> Option<&'static str> {
    let outcome = match outcome? {
        StationOutcome::None => ArchivedOutcome::None,
        StationOutcome::Stamped => ArchivedOutcome::Stamped,
        StationOutcome::NotPassed => ArchivedOutcome::NotPassed,
        StationOutcome::Unknown(_) => return None,
    };
    Some(archived_status_str(st, outcome))
}

/// plan 那一列带给清单项的调度字段：照 `PLAN_FIELDS` 从该列逐键照搬，不另算。旧 server
/// 的列缺 requirementOverlap 与 archiveAfter 时，wire 类型的 default 已把两者读成空数组。
fn schedule_of(entry: &PlanChangeEntry) -> serde_json::Map<String, serde_json::Value> {
    let row = serde_json::to_value(entry).unwrap_or_default();
    specseal_desktop_core::query::PLAN_FIELDS
        .iter()
        .filter_map(|&key| row.get(key).map(|value| (key.to_string(), value.clone())))
        .collect()
}

/// `remote_list_changes` 的 payload：清单项＋顶层 planError（成环时为消息，否则 null）、
/// plan 的 next 与尚未转出的刀（plan 不可得时为 null 与空数组）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChangeList {
    pub changes: Vec<RemoteChangeItem>,
    pub plan_error: Option<String>,
    pub next: Option<String>,
    pub unpromoted_cuts: Vec<PlanUnpromotedCut>,
}

/// 清单合并 plan（D5）：顺序与调度字段来自 [`display_order`]。GET /plan 唯一的 409
/// 是依赖成环——planError 带消息；其他错误（旧 server 的 404、连接失败）planError
/// 为 null，不打扰用户。
pub(crate) fn merge_plan(
    changes: Vec<ChangeSummary>,
    board: &BoardOrderDoc,
    plan: Result<PlanResponse, RemoteError>,
) -> RemoteChangeList {
    let (plan, plan_error) = match plan {
        Ok(plan) => (Some(plan), None),
        Err(error) => (None, (error.status == Some(409)).then_some(error.message)),
    };
    let changes = display_order(changes, board, plan.as_ref())
        .into_iter()
        .map(|(summary, entry)| RemoteChangeItem {
            stations: station_fields(&summary),
            summary,
            schedule: entry.map(schedule_of),
        })
        .collect();
    let (next, unpromoted_cuts) = plan.map(|p| (p.next, p.unpromoted_cuts)).unwrap_or_default();
    RemoteChangeList { changes, plan_error, next, unpromoted_cuts }
}

/// 变更卡的显示序（清单与拖排共用，D5／D6）：有 plan 时照其配置序，plan 没列到
/// 的项（两次请求之间添加、坏 meta 被略过）接在末尾维持 server 序——排列规则与本地
/// 看板同一条（desktop-core `query::plan_placed`）；无 plan 时照 board overlay。每项
/// 附上它在 plan 里的那一列（有的话）。
fn display_order<'p>(
    mut changes: Vec<ChangeSummary>,
    board: &BoardOrderDoc,
    plan: Option<&'p PlanResponse>,
) -> Vec<(ChangeSummary, Option<&'p PlanChangeEntry>)> {
    let Some(plan) = plan else {
        overlay_changes_order(&mut changes, board);
        return changes.into_iter().map(|c| (c, None)).collect();
    };
    let placed: Vec<&str> = plan.changes.iter().map(|e| e.name.as_str()).collect();
    specseal_desktop_core::query::plan_placed(changes, &placed, |c| c.name.as_str())
        .into_iter()
        .map(|c| {
            let entry = plan.changes.iter().find(|e| e.name == c.name);
            (c, entry)
        })
        .collect()
}

/// 稳定排序叠上 rank 复合键（与本地 board_sorted_changes 同构——决策 4）：
/// 缺值置顶维持 server 回传序、具值依 rank 字节字典序升幂、同值以名称决断。
fn sort_with_ranks<T>(
    items: &mut [T],
    ranks: &BTreeMap<String, String>,
    name_of: impl Fn(&T) -> &str,
) {
    items.sort_by(|x, y| match (ranks.get(name_of(x)), ranks.get(name_of(y))) {
        (None, None) => std::cmp::Ordering::Equal, // 稳定排序保留 server 回传序
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(a), Some(b)) => a.cmp(b).then_with(|| name_of(x).cmp(name_of(y))),
    });
}

pub(crate) fn overlay_changes_order(items: &mut [ChangeSummary], board: &BoardOrderDoc) {
    sort_with_ranks(items, &board.changes, |c| &c.name);
}

pub(crate) fn overlay_discussions_order(items: &mut [DiscussionInfo], board: &BoardOrderDoc) {
    sort_with_ranks(items, &board.discussions, |d| &d.slug);
}

/// 变更卡所属栏——与前端 changeStage 的推导同构：全完成＝已就绪优先；
/// meta 开工章（wire 的 startedAt）或任务完成数 > 0＝进行中（fallback 涵盖
/// 手改 tasks.md 等绕过工具的写入路径）；其余＝提案中。
pub fn change_stage(c: &ChangeSummary) -> u8 {
    if c.total_tasks > 0 && c.completed_tasks >= c.total_tasks {
        2
    } else if c.started_at.is_some() || c.completed_tasks > 0 {
        1
    } else {
        0
    }
}

/// reorder 一次尝试所需的 server 现况：两份清单（修剪与栏推导用）、board
/// resource 内容与其 CAS revision，以及 plan（显示序与声明依赖图；不可得为 None）。
#[derive(Debug, Clone)]
pub(crate) struct BoardSnapshot {
    pub(crate) changes: Vec<ChangeSummary>,
    pub(crate) discussions: Vec<DiscussionInfo>,
    pub(crate) content: Option<String>,
    pub(crate) revision: u64,
    pub(crate) plan: Option<PlanResponse>,
}

/// `respread`（调用端的判定：变更卡为缺 rank 或 rank 序与显示序不一致，讨论卡为缺
/// rank）时依当前显示序整栏补章（决策 5——等距键只落在 board resource 图内，与本地
/// reorder 的补章语意同构），否则沿用现值；回传栏成员的 id→rank 表。
fn ensure_column_ranks<'a>(
    members: &[&'a str],
    map: &mut BTreeMap<String, String>,
    respread: bool,
) -> HashMap<&'a str, String> {
    if respread {
        let keys = specseal_core::rank::spread(members.len());
        for (member, key) in members.iter().zip(&keys) {
            map.insert((*member).to_string(), key.clone());
        }
        members.iter().copied().zip(keys).collect()
    } else {
        members
            .iter()
            .map(|member| (*member, map[*member].clone()))
            .collect()
    }
}

fn card_not_found(id: &str) -> RemoteError {
    RemoteError {
        message: format!("查无此卡：{id}"),
        reason: Some("not_found".to_string()),
        status: None,
        evidence: None,
    }
}

/// 计算一次拖排写回的全文（决策 5；add-change-plan-remote D6）：修剪不在现行清单
/// 的条目 → 推导被拖卡所在栏成员（显示序）→ 缺 rank 或 rank 序与显示序不一致时
/// 整栏补章 → 落点邻居中点键 → 有 plan 时检查声明依赖 → 串行化。
pub(crate) fn reorder_full_text(
    snapshot: &BoardSnapshot,
    kind: &str,
    id: &str,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> Result<String, RemoteError> {
    let mut doc = BoardOrderDoc::from_content(snapshot.content.as_deref());
    doc.changes
        .retain(|name, _| snapshot.changes.iter().any(|c| &c.name == name));
    doc.discussions
        .retain(|slug, _| snapshot.discussions.iter().any(|d| &d.slug == slug));

    match kind {
        "change" => {
            let ordered = display_order(snapshot.changes.clone(), &doc, snapshot.plan.as_ref());
            let (dragged, _) = ordered
                .iter()
                .find(|(c, _)| c.name == id)
                .ok_or_else(|| card_not_found(id))?;
            // 被拖卡本身被 plan 略过（坏 meta）：写进 rank 也会被显示序排回栏尾——与本地
            // 写坏 meta 被拒同构，回引擎同一句错误、不发 PUT。
            if let Some(skipped) =
                snapshot.plan.iter().flat_map(|p| &p.skipped).find(|s| s.change == id)
            {
                let broken = specseal_core::model::MetaError {
                    change: id.to_string(),
                    file: specseal_core::model::change_meta_file(
                        specseal_core::workspace::DEFAULT_SPEC_DIR,
                        id,
                        specseal_core::model::META_FILE,
                    ),
                    reason: skipped.reason.clone(),
                };
                return Err(RemoteError {
                    message: broken.to_string(),
                    reason: Some("invalid_config".to_string()),
                    status: None,
                    evidence: None,
                });
            }
            let stage = change_stage(dragged);
            // 栏成员＝画面上同栏的全部卡，含 plan 略过的卡（坏 meta 排在栏尾）：board
            // resource 写得进它的 rank，拖到它之后也要落在栏尾，所以它照常参与重派与落点。
            let members: Vec<(&str, bool)> = ordered
                .iter()
                .filter(|(c, _)| change_stage(c) == stage)
                .map(|(c, entry)| (c.name.as_str(), entry.is_some()))
                .collect();
            let column: Vec<&str> = members.iter().map(|(name, _)| *name).collect();
            // 缺 rank 或 rank 序与显示序不一致（plan 以声明依赖修正过排序）时整栏重派——
            // 判定与本地拖排同一条（rank::ranked_in_order）。
            let current: Vec<Option<&str>> =
                column.iter().map(|m| doc.changes.get(*m).map(String::as_str)).collect();
            let respread = !specseal_core::rank::ranked_in_order(&current);
            let ranks = ensure_column_ranks(&column, &mut doc.changes, respread);
            let key = specseal_core::rank::neighbor_midpoint(&ranks, prev_id, next_id);
            doc.changes.insert(id.to_string(), key);
            if let Some(plan) = &snapshot.plan {
                // 拖放后的串行＝plan 有配置的栏成员依新 rank 排序：plan 略过的卡不列入——
                // 引擎视对它的依赖为已满足，与本机拖排（引擎 move_rank 写入前的依赖检查）的判定范围相同。只挡
                // 涉及被拖卡的配对，消息与 local 同一句（引擎的同一判定）。
                let mut sequence: Vec<&str> = members
                    .iter()
                    .filter(|(_, placed)| *placed)
                    .map(|(name, _)| *name)
                    .collect();
                sort_with_ranks(&mut sequence, &doc.changes, |name| *name);
                let depends_on: BTreeMap<String, Vec<String>> = plan
                    .changes
                    .iter()
                    .map(|e| (e.name.clone(), e.depends_on.clone()))
                    .collect();
                specseal_core::plan::blocked_move(&sequence, &depends_on, id).map_err(
                    |blocked| RemoteError {
                        message: blocked.to_string(),
                        reason: Some("refused".to_string()),
                        status: None,
                        evidence: None,
                    },
                )?;
            }
        }
        "discussion" => {
            let mut ordered = snapshot.discussions.clone();
            overlay_discussions_order(&mut ordered, &doc);
            if !ordered.iter().any(|d| d.slug == id) {
                return Err(card_not_found(id));
            }
            let column: Vec<&str> = ordered.iter().map(|d| d.slug.as_str()).collect();
            let unranked = column.iter().any(|slug| !doc.discussions.contains_key(*slug));
            let ranks = ensure_column_ranks(&column, &mut doc.discussions, unranked);
            let key = specseal_core::rank::neighbor_midpoint(&ranks, prev_id, next_id);
            doc.discussions.insert(id.to_string(), key);
        }
        other => {
            return Err(RemoteError {
                message: format!("无效的卡片类别：{other}"),
                reason: Some("invalid_argument".to_string()),
                status: None,
                evidence: None,
            })
        }
    }
    serde_json::to_string(&doc).map_err(|error| RemoteError {
        message: format!("board resource 串行化失败：{error}"),
        reason: None,
        status: None,
        evidence: None,
    })
}

/// remote 的讨论记录回应：与本地的 `specseal_desktop_core::discussions::DiscussionDocument`
/// 同形（`{ content, cuts }`），`cuts` 原样转交 server 回应的 protocol 类型（同
/// [`RemoteChangeList`] 的 `unpromoted_cuts`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteDiscussionDocument {
    pub content: String,
    pub cuts: Vec<DiscussionCut>,
}

/// GET /discussions/{slug} 的结果转成桌面的讨论记录回应（旧 server 缺 `cuts` 时
/// protocol 已读作空数组），404 与本地语意一致为 None。
pub(crate) fn discussion_document_of(
    shown: Result<ShowDiscussionResponse, RemoteError>,
) -> Result<Option<RemoteDiscussionDocument>, RemoteError> {
    match shown {
        Ok(shown) => Ok(Some(RemoteDiscussionDocument { content: shown.content, cuts: shown.cuts })),
        Err(e) if e.status == Some(404) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 拖排写回的 CAS 收敛循环（决策 5）：读现况 → 重算全文 → PUT 带 If-Match；
/// 409 重读重算重试恰一次，再败原样回错——调用端刷新 server 现况，绝不保留
/// 未落档的假象顺序。
pub(crate) fn reorder_via(
    read: impl Fn() -> Result<BoardSnapshot, RemoteError>,
    put: impl Fn(&str, u64) -> Result<(), RemoteError>,
    kind: &str,
    id: &str,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> Result<(), RemoteError> {
    let mut retried = false;
    loop {
        let snapshot = read()?;
        let text = reorder_full_text(&snapshot, kind, id, prev_id, next_id)?;
        match put(&text, snapshot.revision) {
            Ok(()) => return Ok(()),
            Err(error)
                if !retried && error.reason.as_deref() == Some("revision_conflict") =>
            {
                retried = true;
            }
            Err(error) => return Err(error),
        }
    }
}

/// 逐操作的 capability 描述（决策 2）：来源＝决策 1 矩阵常量＋handshake 的
/// events 声明。serde 化即随 remote_open 回 TS 的 payload；UI 据此停用
/// affordance。本地 session 的对应描述全真——同一 UI 路径、零分岐维护。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    // (a) 直达
    pub list_changes: bool,
    pub list_specs: bool,
    pub status: bool,
    pub get_document: bool,
    pub set_task_done: bool,
    pub archive: bool,
    pub list_discussions: bool,
    pub get_discussion_document: bool,
    pub promote_discussion: bool,
    pub archive_discussion: bool,
    // (b) 组合
    pub set_all_tasks: bool,
    // 添加的 server 纯读取面（封存、搜索、正式规格内文）
    pub list_archived: bool,
    pub get_archived_document: bool,
    pub archived_capabilities: bool,
    pub search_workspace: bool,
    pub get_spec_document: bool,
    // 动词端点直达（remote-verb-parity）：唯读衍生查找全 role 真、写入动词
    // 依 handshake 的 role 呈现（server 仍是最终权限防线）。
    pub validate: bool,
    pub analyze: bool,
    pub delete_change: bool,
    pub move_task: bool,
    // 看板拖排直达 board resource（remote-board-order 决策 7）：依 role 翻真
    //（editor 真、reader 假——server 的 PUT /board-order 以同一 role bit 强制）。
    pub reorder_card: bool,
    /// 前置编辑（add-change-plan-remote D7）：与 reorderCard 同源依 role 翻真
    ///（server 的 POST /changes/{name}/depends 以 editor role 强制）——reader
    /// 的调度分页因此唯读、不长编辑控制项。
    pub set_depends: bool,
    // change 诠释数据与 capability 清单（remote-read-parity）：ChangeStatus
    // 已携归属四栏与 deltaCapabilities，TS 端以既有 remote_status payload
    // 映射实作——数据在 wire 上，capability 为真；旧 server 不送的字段以
    // 缺席呈现（诚实降级，缺的是字段而非能力）。
    pub change_meta: bool,
    pub change_capabilities: bool,
    /// 认领（remote-claim-ownership D4）：RemoteOnly 动词，依 handshake role
    /// 呈现。wire 的 capability 声明没有专属的 claim 位，而 editor 限定的写入
    /// 动词共用同一道 role 闸门——沿 reorderCard 借 policyWrite 的既有作法，
    /// 由 deleteChange 这个「本 membership 可写 change」的声明代读角色。
    pub claim: bool,
    /// 此 membership 是否可写 workflow policy；server 仍是最终权限防线。
    pub policy_write: bool,
    /// handshake 声明了事件能力（SSE transport 或 polling）——缺席时 UI 退化
    /// 为手动重整。
    pub live_updates: bool,
}

impl RemoteCapabilities {
    fn from_binding(binding: &BindingResponse) -> RemoteCapabilities {
        let events = &binding.capabilities.events;
        let live_updates = events.polling.is_some()
            || events
                .transports
                .iter()
                .any(|t| t.kind == TransportKind::Sse);
        // 「本 membership 可写 change」的既有声明（claim 同源）：server 对 reader
        // 的每个写入都回 403，写入面随它停用（server-reader-write-guard D5）。
        // 下方 reorder_card／set_depends 沿用的 policyWrite 与 deleteChange 在
        // server 端都等于 editor 角色，两个来源等价。
        let writable = binding.capabilities.delete_change;
        RemoteCapabilities {
            list_changes: true,
            list_specs: true,
            status: true,
            get_document: true,
            set_task_done: writable,
            archive: writable,
            list_discussions: true,
            get_discussion_document: true,
            promote_discussion: writable,
            archive_discussion: writable,
            set_all_tasks: writable,
            list_archived: true,
            get_archived_document: true,
            archived_capabilities: true,
            search_workspace: true,
            get_spec_document: true,
            validate: binding.capabilities.validate,
            analyze: binding.capabilities.analyze,
            delete_change: binding.capabilities.delete_change,
            move_task: binding.capabilities.move_task,
            reorder_card: binding.capabilities.policy_write,
            set_depends: binding.capabilities.policy_write,
            change_meta: true,
            change_capabilities: true,
            claim: writable,
            policy_write: binding.capabilities.policy_write,
            live_updates,
        }
    }
}

/// `/config` 经 desktop-core 文本 seam 后交给前端的设置快照。remote 无
/// `.specseal.yaml` 面，仍保留空 app 字段以沿用 SettingsSnapshot 的稳定形状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsSnapshot {
    pub app: AppSettings,
    pub workflow: RemoteWorkflowSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkflowSettings {
    #[serde(flatten)]
    pub settings: WorkflowSettings,
    pub revision: u64,
}

/// Tauri 保留 remote protocol 的 machine-readable reason/status，让前端可将
/// revision_conflict 与一般错误分流；message 仍是用户可读单行文本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsError {
    pub message: String,
    pub reason: Option<String>,
    pub status: Option<u16>,
}

impl RemoteSettingsError {
    pub fn local(message: impl Into<String>) -> RemoteSettingsError {
        RemoteSettingsError {
            message: message.into(),
            reason: Some("invalid_config".to_string()),
            status: None,
        }
    }

    pub fn command(message: impl Into<String>) -> RemoteSettingsError {
        RemoteSettingsError {
            message: message.into(),
            reason: None,
            status: None,
        }
    }
}

impl From<RemoteError> for RemoteSettingsError {
    fn from(error: RemoteError) -> Self {
        RemoteSettingsError {
            message: error.message,
            reason: error.reason,
            status: error.status,
        }
    }
}

/// handshake 成功的打开结果：locator 识别、显示名与 capability 描述——
/// serde 化即 remote_open 回 TS 的 payload。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOpenInfo {
    pub project_key: String,
    pub project_name: String,
    pub repo_key: String,
    pub repo_name: String,
    pub capabilities: RemoteCapabilities,
}

/// 讨论清单的 TS 形状：active＋archived（决策 1——listDiscussions 直达，
/// 背后是两次 `/discussions` 查找）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionLists {
    pub active: Vec<DiscussionInfo>,
    pub archived: Vec<DiscussionInfo>,
}

/// 组合类写入中止时的回报：已完成笔数＋当下错误（规格「批量任务操作……
/// 中途失败 SHALL 中止并回报已完成笔数」）。
#[derive(Debug)]
pub struct SetTasksFailure {
    pub completed: usize,
    pub error: RemoteError,
}

/// 以 project[/repo] 识别对 origin handshake（决策 6，fail-closed）：成功回
/// workspace 把手与打开结果；任何失败（403/404/多义）原样回错、不创建任何
/// runtime 状态。
pub fn open_workspace(
    origin: &str,
    target: &str,
    manager: &Arc<TokenManager>,
    credentials: &dyn CredentialStore,
) -> Result<(RemoteWorkspace, RemoteOpenInfo), RemoteError> {
    let (project, repo) = match target.split_once('/') {
        Some((project, repo)) => (project.trim(), Some(repo.trim().to_string())),
        None => (target.trim(), None),
    };
    let project_base = format!(
        "{}/api/specseal/v1/projects/{project}",
        origin.trim_end_matches('/')
    );
    let repo_header = repo.clone();
    let binding = manager.execute(credentials, |token| {
        Client::new(&project_base, token, repo_header.as_deref()).handshake()
    })?;
    let info = RemoteOpenInfo {
        project_key: binding.project.key.clone(),
        project_name: binding.project.name.clone(),
        repo_key: binding.repo.key.clone(),
        repo_name: binding.repo.name.clone(),
        capabilities: RemoteCapabilities::from_binding(&binding),
    };
    let workspace = RemoteWorkspace {
        project_base,
        // 以 handshake 裁定后的 repo 为准（省略 repo 时 server 绑定唯一 repo）。
        repo: binding.repo.key,
        manager: Arc::clone(manager),
    };
    Ok((workspace, info))
}

/// chooser 在选定 project/repo 前读取登录者可见 scopes。此请求只有 bearer，
/// 不携带 fabricated repo header；membership 过滤由 server 负责。
pub fn list_scopes(
    origin: &str,
    manager: &Arc<TokenManager>,
    credentials: &dyn CredentialStore,
) -> Result<ScopesResponse, RemoteError> {
    let api_root = format!("{}/api/specseal/v1", origin.trim_end_matches('/'));
    manager.execute(credentials, |token| {
        Client::new(&api_root, token, None).list_scopes()
    })
}

/// Server 对一个 checkout 的工具回应的技能，连同那个 checkout 的工具选集。
pub struct ServedSkills {
    selection: ToolSelection,
    response: SkillsResponse,
}

impl ServedSkills {
    /// 技能档更新的后半：把全文写进 `checkout`。和 CLI 的 `specseal update` 用同一个
    /// 安装函数——文件集合等于 Server 的回应，不经降级守门；回应和 checkout 对不上时在
    /// 任何写入之前拒绝。回报和本机的更新同形，失败为单行消息。
    pub fn install(self, checkout: &Path) -> Result<serde_json::Value, RemoteError> {
        let installed = remote_skills::install(checkout, self.selection, self.response)
            .map_err(|e| unavailable(e.to_string().lines().next().unwrap_or_default().to_string()))?;
        Ok(specseal_desktop_core::project::update_outcome_payload(&installed.outcome))
    }
}

/// 一个 handshake 成功后的 remote workspace 把手：数据面操作的 (a) 直达与
/// (b) 组合实作，全部经 TokenManager 逐请求建构 Client（决策 4、7）。
pub struct RemoteWorkspace {
    project_base: String,
    repo: String,
    manager: Arc<TokenManager>,
}

// 手写 Debug：TokenManager 持有 bearer，绝不进任何 Debug 输出。
impl std::fmt::Debug for RemoteWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteWorkspace")
            .field("project_base", &self.project_base)
            .field("repo", &self.repo)
            .finish_non_exhaustive()
    }
}

impl RemoteWorkspace {
    /// 以已知的 locator 识别直接建构把手——open 之后的数据面调用走这里
    /// （handshake 是 session 前置、不是逐请求前置），命令层据此无状态重建。
    pub fn at(
        origin: &str,
        project: &str,
        repo: &str,
        manager: &Arc<TokenManager>,
    ) -> RemoteWorkspace {
        RemoteWorkspace {
            project_base: format!(
                "{}/api/specseal/v1/projects/{project}",
                origin.trim_end_matches('/')
            ),
            repo: repo.to_string(),
            manager: Arc::clone(manager),
        }
    }

    /// 逐请求建构 Client 运行一击（token 生命周期由 TokenManager 承担）。
    fn run<T>(
        &self,
        credentials: &dyn CredentialStore,
        call: impl Fn(&Client) -> Result<T, RemoteError>,
    ) -> Result<T, RemoteError> {
        self.manager.execute(credentials, |token| {
            call(&Client::new(&self.project_base, token, Some(&self.repo)))
        })
    }

    fn run_write<T>(
        &self,
        credentials: &dyn CredentialStore,
        call: impl Fn(&Client) -> Result<T, RemoteError>,
    ) -> Result<T, RemoteError> {
        self.manager.execute_write(credentials, |token| {
            call(&Client::new(&self.project_base, token, Some(&self.repo)))
        })
    }

    /// 清单同时取 board resource 与 plan 于 Rust 侧合并排序（决策 4；
    /// add-change-plan-remote D5）：UI 与 TS 层不做排序、不知道 board resource
    /// 存在。board resource 读取失败（端点缺席的旧 server）视为缺席；plan 的
    /// 失败交给 `merge_plan` 分流。
    ///
    /// `checkout` 是这个 remote 项目绑定的本机工作副本（没有就是 `None`）。有的话，
    /// 任务数相符的已盖章变更各多取一次单笔回应，拿它的 scope 比 checkout 里的文件
    /// （[`refine_with_checkout`]）；那一次读取失败时维持只比任务数的结果，清单不因此失败。
    pub fn list_changes(
        &self,
        credentials: &dyn CredentialStore,
        checkout: Option<&Path>,
    ) -> Result<RemoteChangeList, RemoteError> {
        let response = self.run(credentials, |client| client.list_changes())?;
        let board = self.board_order_doc(credentials);
        let plan = self.run(credentials, |client| client.plan());
        let mut list = merge_plan(response.changes, &board, plan);
        if let Some(root) = checkout {
            let stamped = list
                .changes
                .iter_mut()
                .filter(|item| [&REVIEW, &VERIFY].into_iter().any(|st| stamp_holds_so_far(&item.summary, st)));
            for item in stamped {
                let name = item.summary.name.clone();
                if let Ok(status) = self.run(credentials, |client| client.get_change(&name)) {
                    refine_with_checkout(item, status.review.as_ref(), status.verify.as_ref(), root);
                }
            }
        }
        Ok(list)
    }

    /// 读 board resource 并解析为桌面侧形状；任何读取失败与缺席同义
    /// （决策 6：爆炸半径＝退回缺省序）。
    fn board_order_doc(&self, credentials: &dyn CredentialStore) -> BoardOrderDoc {
        let content = self
            .run(credentials, |client| client.board_order())
            .ok()
            .and_then(|response| response.content);
        BoardOrderDoc::from_content(content.as_deref())
    }

    pub fn list_specs(
        &self,
        credentials: &dyn CredentialStore,
    ) -> Result<ListSpecsResponse, RemoteError> {
        self.run(credentials, |client| client.list_specs())
    }

    /// Server 提供给 `checkout` 的工具的技能（remote-skill-delivery D6），连同解析好的
    /// 工具选集：握手没有声明技能、或 checkout 没有任何工具时为 None。`contents` 为 false
    /// 时只有摘要。
    fn served_skills(
        &self,
        credentials: &dyn CredentialStore,
        checkout: &Path,
        contents: bool,
    ) -> Result<Option<ServedSkills>, RemoteError> {
        let app = AppConfig::load(&checkout.join(".specseal.yaml")).map_err(|e| unavailable(e.to_string()))?;
        // 无效的描述子不成为目标：探测略过它，更新由安装计划在写入前回报。
        let selection = ToolSelection::resolve(checkout, &app);
        let targets = remote_skills::targets_of(&selection);
        if targets.is_empty() {
            return Ok(None);
        }
        if self.run(credentials, |client| client.handshake())?.capabilities.skills.is_none() {
            return Ok(None);
        }
        let request = SkillsRequest { targets, contents };
        let response = self.run(credentials, |client| client.skills(&request))?;
        Ok(Some(ServedSkills { selection, response }))
    }

    /// 技能档探测：以 Server 的摘要比对 checkout，不下载全文。Server 没有提供技能时
    /// 为 None（没有可比的基准，前端不提示）。
    pub fn probe_assets(
        &self,
        credentials: &dyn CredentialStore,
        checkout: &Path,
    ) -> Result<Option<serde_json::Value>, RemoteError> {
        Ok(self.served_skills(credentials, checkout, false)?.map(|served| {
            let digests = remote_skills::digests(&served.response);
            specseal_desktop_core::project::probe_remote_assets_at(checkout, &served.response.version, &digests)
        }))
    }

    /// 技能档更新的前半：向 Server 取得 `checkout` 的工具的技能全文。不写任何文件——
    /// 写入在 [`ServedSkills::install`]，命令层只在那一段暂停文件监看。
    pub fn skills_to_install(
        &self,
        credentials: &dyn CredentialStore,
        checkout: &Path,
    ) -> Result<ServedSkills, RemoteError> {
        self.served_skills(credentials, checkout, true)?
            .ok_or_else(|| unavailable("这台 Server 没有提供技能".to_string()))
    }

    /// GET `/config` 的文档原文一律经 desktop-core from-text seam；revision
    /// 与解析结果同一份 response snapshot，避免字段与 CAS token 分裂。
    pub fn read_settings(
        &self,
        credentials: &dyn CredentialStore,
    ) -> Result<RemoteSettingsSnapshot, RemoteSettingsError> {
        let config = self
            .run(credentials, |client| client.config())
            .map_err(RemoteSettingsError::from)?;
        Ok(RemoteSettingsSnapshot {
            app: AppSettings {
                tools: Vec::new(),
                custom_tools: Vec::new(),
                parse_error: None,
            },
            workflow: RemoteWorkflowSettings {
                settings: read_workflow_settings_from_text(config.content.as_deref()),
                revision: config.revision,
            },
        })
    }

    /// 政策四字段 targeted rewrite：GET 全文 → 共用文本 seam → PUT 全文＋
    /// 画面读得的 expected revision。PUT 仍由 server 做 role／验证／CAS。
    pub fn write_workflow_fields(
        &self,
        credentials: &dyn CredentialStore,
        fields: &WorkflowPolicyFields,
        expected_revision: u64,
    ) -> Result<u64, RemoteSettingsError> {
        self.manager
            .ensure_write_allowed()
            .map_err(RemoteSettingsError::from)?;
        let config = self
            .run(credentials, |client| client.config())
            .map_err(RemoteSettingsError::from)?;
        let rewritten =
            rewrite_workflow_fields_text(config.content.as_deref().unwrap_or_default(), fields)
                .map_err(RemoteSettingsError::local)?;
        self.run_write(credentials, |client| {
            client.put_config(&rewritten, expected_revision)
        })
        .map(|response| response.revision)
        .map_err(RemoteSettingsError::from)
    }

    /// schema 键 targeted rewrite（desktop-schema-panel design D2）：GET 全文 →
    /// 引擎 byte-preserving setter → PUT 全文＋expected revision。与政策字段
    /// 写入同一条 revision 守门信道，坏档在 setter 即拒。
    pub fn write_workflow_schema(
        &self,
        credentials: &dyn CredentialStore,
        name: &str,
        expected_revision: u64,
    ) -> Result<u64, RemoteSettingsError> {
        self.manager
            .ensure_write_allowed()
            .map_err(RemoteSettingsError::from)?;
        let config = self
            .run(credentials, |client| client.config())
            .map_err(RemoteSettingsError::from)?;
        let rewritten =
            specseal_core::config::set_workflow_schema_text(config.content.as_deref(), name)
                .map_err(|e| RemoteSettingsError::local(e.to_string()))?;
        self.run_write(credentials, |client| {
            client.put_config(&rewritten, expected_revision)
        })
        .map(|response| response.revision)
        .map_err(RemoteSettingsError::from)
    }

    /// context/rules/review targeted rewrite；未指定的区块不触及，空值沿用 seam 的
    /// 移除语意。没有任何省略 expected revision 的写入路径。
    pub fn write_workflow_content(
        &self,
        credentials: &dyn CredentialStore,
        edit: &ContentEdit,
        expected_revision: u64,
    ) -> Result<u64, RemoteSettingsError> {
        self.manager
            .ensure_write_allowed()
            .map_err(RemoteSettingsError::from)?;
        let config = self
            .run(credentials, |client| client.config())
            .map_err(RemoteSettingsError::from)?;
        let rewritten = rewrite_workflow_content_text(config.content.as_deref().unwrap_or_default(), edit)
            .map_err(RemoteSettingsError::local)?;
        self.run_write(credentials, |client| {
            client.put_config(&rewritten, expected_revision)
        })
        .map(|response| response.revision)
        .map_err(RemoteSettingsError::from)
    }

    pub fn list_archived(
        &self,
        credentials: &dyn CredentialStore,
    ) -> Result<RemoteArchivedList, RemoteError> {
        let archived = self
            .run(credentials, |client| client.archived_list())?
            .archived
            .into_iter()
            .map(|item| RemoteArchivedItem {
                review_status: outcome_status(&REVIEW, item.review_outcome.as_ref()),
                verify_status: outcome_status(&VERIFY, item.verify_outcome.as_ref()),
                item,
            })
            .collect();
        Ok(RemoteArchivedList { archived })
    }

    pub fn spec_document(
        &self,
        credentials: &dyn CredentialStore,
        capability: &str,
    ) -> Result<SpecDocumentResponse, RemoteError> {
        self.run(credentials, |client| client.spec_document(capability))
    }

    pub fn search_workspace(
        &self,
        credentials: &dyn CredentialStore,
        query: &str,
    ) -> Result<SearchResponse, RemoteError> {
        self.run(credentials, |client| client.search(query))
    }

    pub fn archived_document(
        &self,
        credentials: &dyn CredentialStore,
        dated_name: &str,
        artifact: &str,
    ) -> Result<SpecDocumentResponse, RemoteError> {
        self.run(credentials, |client| {
            client.archived_artifact(dated_name, artifact)
        })
    }

    pub fn archived_capabilities(
        &self,
        credentials: &dyn CredentialStore,
        dated_name: &str,
    ) -> Result<Vec<String>, RemoteError> {
        self.run(credentials, |client| {
            client.archived_capabilities(dated_name)
        })
    }

    /// 一站的活工单（drawer-quality-ticket-tab D2）：`GET /changes/{name}/{station}`
    /// 的结构化 rounds。404（无工单或 change 不存在）→ `None`；其他错误原样上抛
    /// ——脱机不得被读成「没有工单」。参数顺序同邻近的 `document(credentials, change,
    /// artifact)`：change 在前、站别在后。
    pub fn station_ticket(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        station: &str,
    ) -> Result<Option<ReviewTicketResponse>, RemoteError> {
        self.run(credentials, |client| client.station_ticket_if_any(station, change))
    }

    pub fn change_status(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
    ) -> Result<ChangeStatus, RemoteError> {
        self.run(credentials, |client| client.get_change(change))
    }

    pub fn document(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        artifact: &str,
    ) -> Result<ArtifactContent, RemoteError> {
        let artifact = artifact_id(artifact);
        self.run(credentials, |client| client.get_artifact(change, artifact))
    }

    pub fn set_task_done(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        task: &str,
        done: bool,
    ) -> Result<(), RemoteError> {
        self.run_write(credentials, |client| {
            if done {
                client.task_done(change, task, &[], None).map(|_| ())
            } else {
                client.task_undone(change, task).map(|_| ())
            }
        })
    }

    pub fn claim(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
    ) -> Result<ClaimResponse, RemoteError> {
        self.run_write(credentials, |client| client.claim(change))
    }

    /// 前置的添加与移除（add-change-plan-remote D7）：POST /changes/{name}/depends，
    /// 守门与消息都是 server 转发的引擎原文；脱机时写入即拒。
    pub fn set_depends(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        on: &[String],
        remove: bool,
    ) -> Result<(), RemoteError> {
        self.run_write(credentials, |client| client.set_depends(change, on, remove))
            .map(|_| ())
    }

    /// 退回提案中:打 DELETE /changes/{name}/in-progress。200 Ack 涵盖实际
    /// 移除与未开工幂等;守门 409 的证据落在 RemoteError::evidence,由
    /// command 层转为与本地 bridge 同形状的结构化错误 JSON。
    pub fn revert_change_to_proposed(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
    ) -> Result<(), RemoteError> {
        // 回应的 removed 旗标 desktop 用不到——看板靠重读清单刷新，不看这句回报。
        self.run_write(credentials, |client| client.in_progress_remove(change)).map(|_| ())
    }

    /// validate 动词（唯读衍生查找）：wire DTO 转回引擎类型，串行化后与本地
    /// verbs::validate_at 的 payload 同形（remote-verb-parity）。
    pub fn validate(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
    ) -> Result<specseal_core::validate::ValidationResult, RemoteError> {
        self.run(credentials, |client| client.validate_change(change))
            .map(specseal_remote::convert::validation_result)
    }

    /// analyze 动词（唯读衍生查找）：payload 与本地 verbs::analyze_at 同形。
    pub fn analyze(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
    ) -> Result<specseal_core::analyzer::AnalyzeReport, RemoteError> {
        self.run(credentials, |client| client.analyze_change(change))
            .map(specseal_remote::convert::analyze_report)
    }

    /// 删除变更＝server 端 discard 全语意（guard/unlink/原子删除）；force 由
    /// 调用端决定（桌面固定 true——决策 3：与本地无 guard 直删同模式）。
    pub fn delete_change(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        force: bool,
    ) -> Result<(), RemoteError> {
        self.run_write(credentials, |client| client.discard(change, force))
            .map(|_| ())
    }

    /// 任务搬移：index 寻址直达 server 端点，重编号效果与本地拖排一致。
    pub fn move_task(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        from: usize,
        to: usize,
        before: Option<bool>,
    ) -> Result<(), RemoteError> {
        self.run_write(credentials, |client| client.move_task(change, from, to, before))
            .map(|_| ())
    }

    /// 封存。两个 carry 旗标是三选项对话框「照样带走」的结果（station-status-and-landing
    /// D7）：带着该站未结的工单封存。一般封存两者都是 false。
    pub fn archive(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        carry_review: bool,
        carry_verify: bool,
    ) -> Result<ArchiveResponse, RemoteError> {
        self.run_write(credentials, |client| client.archive(change, carry_review, carry_verify))
    }

    /// 三选项对话框的「放弃审查／放弃验证」：删掉该站的工单。`station` 是引擎的站别词
    /// （`review`／`verify`），由调用端先认过。
    pub fn discard_station(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        station: &str,
    ) -> Result<(), RemoteError> {
        self.run_write(credentials, |client| client.station_discard(station, change)).map(|_| ())
    }

    /// active 讨论同样叠 board resource 排序 overlay（决策 4）；archived 清单
    /// 不属看板、维持 server 回传序。
    pub fn list_discussions(
        &self,
        credentials: &dyn CredentialStore,
    ) -> Result<DiscussionLists, RemoteError> {
        let active = self.run(credentials, |client| client.list_discussions(false))?;
        let archived = self.run(credentials, |client| client.list_discussions(true))?;
        let mut active = active.discussions;
        let board = self.board_order_doc(credentials);
        overlay_discussions_order(&mut active, &board);
        Ok(DiscussionLists {
            active,
            archived: archived.discussions,
        })
    }

    /// 看板拖排直达（决策 5）：读清单＋board resource＋plan → 补章／中点 → 声明
    /// 依赖检查 → PUT 全文带 If-Match；409 重读重算重试恰一次，再败原样回错（前端
    /// 刷新 server 现况，不留假象顺序）。全程不触碰任何卡片 meta／frontmatter。
    pub fn reorder_card(
        &self,
        credentials: &dyn CredentialStore,
        kind: &str,
        id: &str,
        prev_id: Option<&str>,
        next_id: Option<&str>,
    ) -> Result<(), RemoteError> {
        reorder_via(
            || {
                let changes = self
                    .run(credentials, |client| client.list_changes())?
                    .changes;
                let discussions = self
                    .run(credentials, |client| client.list_discussions(false))?
                    .discussions;
                let board = self.run(credentials, |client| client.board_order())?;
                // 只有变更卡用得到 plan，而且必须在 board resource 之后读：plan 反映的 board
                // 状态因此不早于 If-Match 的 revision——两次读取之间有人写入时 PUT 会 409
                // 重读，不会拿旧的显示序整栏重派、盖掉别人的拖排。plan 失败（旧 server、
                // 成环、连接）不挡拖排：没有显示序修正与依赖图可查。
                let plan = if kind == "change" {
                    self.run(credentials, |client| client.plan()).ok()
                } else {
                    None
                };
                Ok(BoardSnapshot {
                    changes,
                    discussions,
                    content: board.content,
                    revision: board.revision,
                    plan,
                })
            },
            |content, revision| {
                self.run_write(credentials, |client| client.put_board_order(content, revision))
                    .map(|_| ())
            },
            kind,
            id,
            prev_id,
            next_id,
        )
    }

    /// 讨论记录全文与 server 解析的刀，与本地的讨论记录回应同形；404 回 None。
    pub fn discussion_document(
        &self,
        credentials: &dyn CredentialStore,
        slug: &str,
    ) -> Result<Option<RemoteDiscussionDocument>, RemoteError> {
        discussion_document_of(self.run(credentials, |client| client.show_discussion(slug)))
    }

    pub fn promote_discussion(
        &self,
        credentials: &dyn CredentialStore,
        slug: &str,
        name: Option<&str>,
    ) -> Result<PromoteDiscussionResponse, RemoteError> {
        // 桌面「转为变更」不提供最后一刀标记：wire 的 last 一律 false。
        self.run_write(credentials, |client| client.discussion_promote(slug, name, false))
    }

    pub fn archive_discussion(
        &self,
        credentials: &dyn CredentialStore,
        slug: &str,
    ) -> Result<ArchiveDiscussionResponse, RemoteError> {
        self.run_write(credentials, |client| client.discussion_archive(slug))
    }

    /// (b) 组合：逐任务写回，非原子——中途失败即中止并回报已完成笔数。
    pub fn set_tasks(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        task_ids: &[String],
        done: bool,
    ) -> Result<usize, SetTasksFailure> {
        self.manager
            .ensure_write_allowed()
            .map_err(|error| SetTasksFailure {
                completed: 0,
                error,
            })?;
        let mut completed = 0;
        for task in task_ids {
            self.set_task_done(credentials, change, task, done)
                .map_err(|error| SetTasksFailure { completed, error })?;
            completed += 1;
        }
        Ok(completed)
    }

    /// (b) 组合的 setAllTasks：以 server 的任务清单（apply instructions）取
    /// 未达目标态的任务逐笔写回。
    pub fn set_all_tasks(
        &self,
        credentials: &dyn CredentialStore,
        change: &str,
        done: bool,
    ) -> Result<usize, SetTasksFailure> {
        self.manager
            .ensure_write_allowed()
            .map_err(|error| SetTasksFailure {
                completed: 0,
                error,
            })?;
        let instructions = self
            .run(credentials, |client| client.apply_instructions(change))
            .map_err(|error| SetTasksFailure {
                completed: 0,
                error,
            })?;
        let pending: Vec<String> = instructions
            .tasks
            .into_iter()
            .filter(|task| task.done != done)
            .map(|task| task.id)
            .collect();
        self.set_tasks(credentials, change, &pending, done)
    }
}

/// 远程活工单 → 前端工单数据，与本机同一个组装函数（desktop core 的 `ticket_payload`）。
/// server 比这支 desktop 新、某轮带来不认得的 rules baseline 时回 `None`（空态），
/// 比照封存原文解析失败——不把它画成 replace 的套用规则列。
pub fn station_ticket_payload(ticket: ReviewTicketResponse) -> Option<serde_json::Value> {
    let known = |round: &specseal_protocol::command::ReviewRoundDto| {
        round
            .rules
            .as_ref()
            .is_none_or(|rules| specseal_core::config::ReviewBaseline::parse(&rules.baseline).is_some())
    };
    ticket
        .rounds
        .iter()
        .all(known)
        .then(|| specseal_desktop_core::query::ticket_payload(ticket.rounds))
}

#[cfg(test)]
mod capability_tests {
    use super::RemoteCapabilities;
    use specseal_protocol::binding::{Actor, BindingResponse, Capabilities, ScopeRef};

    fn binding_with(capabilities: Capabilities) -> BindingResponse {
        let scope = |key: &str| ScopeRef {
            id: format!("id_{key}"),
            key: key.to_string(),
            name: key.to_string(),
        };
        BindingResponse {
            actor: Actor { id: "u_1".to_string(), name: "Tester".to_string() },
            project: scope("demo"),
            repo: scope("backend"),
            api_version: "1".to_string(),
            engine_version: "0.1.0".to_string(),
            capabilities,
        }
    }

    #[test]
    fn editor_handshake_unlocks_all_write_capabilities_including_board_reorder() {
        // 规格「capability 驱动停用且不伪造缺口」修订后语意：editor 全操作面
        // 直达，停用清单清空（remote-board-order 决策 7）。
        let caps = RemoteCapabilities::from_binding(&binding_with(Capabilities {
            validate: true,
            analyze: true,
            delete_change: true,
            move_task: true,
            policy_write: true,
            ..Default::default()
        }));
        assert!(caps.validate, "validate follows the handshake");
        assert!(caps.analyze, "analyze follows the handshake");
        assert!(caps.delete_change, "deleteChange follows the handshake");
        assert!(caps.move_task, "moveTask follows the handshake");
        assert!(caps.reorder_card, "board reorder follows the editor role");
        assert!(caps.set_depends, "prerequisite editing follows the editor role like board reorder");
        // server-reader-write-guard D5：其余写入面同样随 deleteChange 的角色声明。
        assert!(caps.set_task_done);
        assert!(caps.set_all_tasks);
        assert!(caps.archive);
        assert!(caps.promote_discussion);
        assert!(caps.archive_discussion);
    }

    #[test]
    fn reader_handshake_keeps_write_verbs_disabled_but_derived_queries_on() {
        let caps = RemoteCapabilities::from_binding(&binding_with(Capabilities {
            validate: true,
            analyze: true,
            delete_change: false,
            move_task: false,
            ..Default::default()
        }));
        assert!(caps.validate, "reader may run the read-only derived queries");
        assert!(caps.analyze);
        assert!(!caps.delete_change, "reader write verbs stay disabled");
        assert!(!caps.move_task);
        assert!(!caps.reorder_card, "reader board reorder stays disabled");
        assert!(!caps.set_depends);
        // server 对 reader 的每个写入都回 403——写入面不得呈现可用。
        assert!(!caps.set_task_done, "reader task check-off stays disabled");
        assert!(!caps.set_all_tasks);
        assert!(!caps.archive);
        assert!(!caps.promote_discussion);
        assert!(!caps.archive_discussion);
    }
}

#[cfg(test)]
mod board_order_tests {
    use super::{overlay_changes_order, overlay_discussions_order, BoardOrderDoc};
    use specseal_protocol::query::{ChangeSummary, DiscussionInfo};

    pub(super) fn change(name: &str, completed: usize, total: usize) -> ChangeSummary {
        ChangeSummary {
            name: name.into(),
            summary: String::new(),
            status: "in-progress".into(),
            completed_tasks: completed,
            total_tasks: total,
            restale_from: Vec::new(),
            meta_error: None,
            repo: None,
            lifecycle: None,
            claimed_by: None,
            started_at: None,
            created_by: None,
            created: None,
            from_discussions: Vec::new(),
            delta_capabilities: Vec::new(),
            modified_at: None,
            review: None,
            verify: None,
            branch: None,
            landed_commit: None,
            fields: Default::default(),
        }
    }

    #[test]
    fn a_server_without_station_fields_gives_no_station_keys() {
        // Scenario「旧 Server 没有字段」：没有数据就没有键——卡片没有标示，封存不出现对话框。
        let list = super::merge_plan(vec![change("demo", 1, 2)], &BoardOrderDoc::default(), Err(super::unavailable("no plan".into())));
        assert!(list.changes[0].stations.is_empty());
        let payload = serde_json::to_value(&list).unwrap();
        for key in ["reviewStatus", "verifyStatus", "review", "verify"] {
            assert!(payload["changes"][0].get(key).is_none(), "{key}: {payload}");
        }
    }

    #[test]
    fn a_state_this_client_does_not_know_reads_as_no_data() {
        use specseal_protocol::query::{StationPhase, StationState};
        let mut summary = change("demo", 1, 1);
        summary.review = Some(StationState { state: StationPhase::Unknown("paused".into()), ..Default::default() });
        summary.verify = Some(StationState { state: StationPhase::InProgress, ..Default::default() });
        let fields = super::station_fields(&summary);
        assert!(!fields.contains_key("reviewStatus"), "{fields:?}");
        assert_eq!(fields["verifyStatus"], "inVerify");
    }

    /// A git checkout in a temp dir with one commit; returns it with its HEAD.
    fn git_checkout() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "T"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("a.rs"), "fn a() {}\n").unwrap();
        git(&["add", "a.rs"]);
        git(&["commit", "-q", "-m", "init"]);
        let head = git(&["rev-parse", "HEAD"]);
        (dir, head)
    }

    /// A list item whose review is stamped over one task, and the single-change
    /// station state that goes with it (the scope and the stamp's commit).
    fn stamped_item(
        scope_path: &str,
        hash: &str,
        commit: Option<&str>,
    ) -> (super::RemoteChangeItem, specseal_protocol::query::StationState) {
        use specseal_protocol::command::ReviewScopeEntryDto;
        use specseal_protocol::query::{StationPhase, StationState};
        let stamped = StationState {
            state: StationPhase::Stamped,
            stamped_at: Some("2026-11-02".into()),
            tasks_total: Some(1),
            rounds: Some(1),
            commit: commit.map(str::to_string),
            scope: vec![ReviewScopeEntryDto { path: scope_path.into(), hash: hash.into() }],
            ..Default::default()
        };
        let mut summary = change("demo", 1, 1);
        summary.review = Some(StationState { scope: Vec::new(), ..stamped.clone() });
        let item = super::RemoteChangeItem { stations: super::station_fields(&summary), summary, schedule: None };
        assert_eq!(item.stations["reviewStatus"], "reviewed");
        (item, stamped)
    }

    #[test]
    fn a_scope_path_outside_the_checkout_is_never_read() {
        // 在线回应的 scope 路径是外部输入：绝对路径与 `..` 不读，读作内容有变。
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "s").unwrap();
        let (checkout, head) = git_checkout();
        let hash = specseal_core::station::content_fingerprint("s");
        let folder = outside.path().file_name().unwrap().to_string_lossy().to_string();
        for path in [secret.display().to_string(), format!("../{folder}/secret.txt")] {
            let (mut item, stamped) = stamped_item(&path, &hash, Some(&head));
            super::refine_with_checkout(&mut item, Some(&stamped), None, checkout.path());
            assert_eq!(item.stations["reviewStatus"], "reviewedStale", "{path}");
        }
    }

    #[test]
    fn files_are_compared_only_when_the_checkout_holds_the_stamps_commit() {
        // 章若盖在 checkout 还没有的 commit 上（别的分支、别台机器），checkout 的文件不是
        // 那一版，比了只会误报「其后有变动」：这时维持只比任务数的结果。章没有 commit 时同样。
        let (checkout, head) = git_checkout();
        // 章之后文件被改成别的内容（不是章的那一版，也不是 commit 当时的那一版）。
        std::fs::write(checkout.path().join("a.rs"), "fn a() { later(); }\n").unwrap();
        let stale_hash = specseal_core::station::content_fingerprint("fn a() { other(); }\n");
        let unknown = "0123456789abcdef0123456789abcdef01234567";
        for (commit, want) in [(Some(head.as_str()), "reviewedStale"), (Some(unknown), "reviewed"), (None, "reviewed"), (Some("--help"), "reviewed")] {
            let (mut item, stamped) = stamped_item("a.rs", &stale_hash, commit);
            super::refine_with_checkout(&mut item, Some(&stamped), None, checkout.path());
            assert_eq!(item.stations["reviewStatus"], want, "{commit:?}");
        }
        // 文件内容与章相符、checkout 含那个 commit：维持已审查。
        let fresh = specseal_core::station::content_fingerprint("fn a() { later(); }\n");
        let (mut item, stamped) = stamped_item("a.rs", &fresh, Some(&head));
        super::refine_with_checkout(&mut item, Some(&stamped), None, checkout.path());
        assert_eq!(item.stations["reviewStatus"], "reviewed");
    }

    #[test]
    fn a_file_still_at_the_stamps_commit_is_not_a_change_after_the_stamp() {
        // 被审的内容在盖章时还没 commit：章记下的 commit 是它的前一版。checkout 含那个
        // commit、文件还是 commit 当时的样子＝只是还没拿到被审的内容，不算其后有变动。
        let (checkout, head) = git_checkout();
        let reviewed = "fn a() { reviewed(); }\n";
        let hash = specseal_core::station::content_fingerprint(reviewed);
        let status = |path: &str| {
            let (mut item, stamped) = stamped_item(path, &hash, Some(&head));
            super::refine_with_checkout(&mut item, Some(&stamped), None, checkout.path());
            item.stations["reviewStatus"].clone()
        };
        assert_eq!(status("a.rs"), "reviewed", "the file is still what the stamp's commit holds");
        std::fs::write(checkout.path().join("a.rs"), reviewed).unwrap();
        assert_eq!(status("a.rs"), "reviewed", "the reviewed content arrived");
        std::fs::write(checkout.path().join("a.rs"), "fn a() { later(); }\n").unwrap();
        assert_eq!(status("a.rs"), "reviewedStale", "neither the reviewed content nor the commit's");
        // 盖章时添加的档：commit 里没有，checkout 也还没有 → 不算；出现别的内容 → 其后有变动。
        assert_eq!(status("new.rs"), "reviewed", "absent at the commit and absent now");
        std::fs::write(checkout.path().join("new.rs"), "fn other() {}\n").unwrap();
        assert_eq!(status("new.rs"), "reviewedStale", "a different file appeared");
    }

    #[test]
    fn a_stamp_without_a_task_count_is_never_compared_with_files() {
        // 引擎的规则：章没有任务数就不判内容（本机清单也是这样）。remote 的比对照同一条。
        let (checkout, head) = git_checkout();
        std::fs::write(checkout.path().join("a.rs"), "fn a() { later(); }\n").unwrap();
        let hash = specseal_core::station::content_fingerprint("fn a() { other(); }\n");
        let (mut item, mut stamped) = stamped_item("a.rs", &hash, Some(&head));
        stamped.tasks_total = None;
        super::refine_with_checkout(&mut item, Some(&stamped), None, checkout.path());
        assert_eq!(item.stations["reviewStatus"], "reviewed");
    }

    #[test]
    fn a_station_that_is_no_longer_stamped_keeps_no_stamp_fields() {
        // 清单与单笔回应之间状态变了（单笔已是审查中）：章的时间与人不留在项目上。
        use specseal_protocol::query::{StationPhase, StationState};
        let (checkout, head) = git_checkout();
        let (mut item, _) = stamped_item("a.rs", "aa", Some(&head));
        assert!(item.stations.contains_key("reviewedAt"));
        let reopened = StationState { state: StationPhase::InProgress, ..Default::default() };
        super::refine_with_checkout(&mut item, Some(&reopened), None, checkout.path());
        assert_eq!(item.stations["reviewStatus"], "inReview");
        assert!(!item.stations.contains_key("reviewedAt") && !item.stations.contains_key("reviewedBy"));
    }

    pub(super) fn discussion(slug: &str) -> DiscussionInfo {
        DiscussionInfo {
            slug: slug.into(),
            topic: slug.to_uppercase(),
            status: "open".into(),
            rounds: 1,
            created: "2026-01-02".into(),
            created_by: None,
            kind: None,
            promoted_to: Vec::new(),
            concluded: None,
            hold: None,
            path: format!("openspec/discussions/{slug}.md"),
            archived: false,
            fields: Default::default(),
        }
    }

    fn names(items: &[ChangeSummary]) -> Vec<&str> {
        items.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn ranked_changes_sort_ascending_with_unranked_on_top_in_server_order() {
        // 规格「remote 排序 overlay 与本地语意同构」＋ board-card-order
        // Example「四卡混排」：W(b)、X(f)、Y(n)、Z(无 rank) → Z、W、X、Y。
        let board = BoardOrderDoc::from_content(Some(
            "{\"changes\":{\"w\":\"b\",\"x\":\"f\",\"y\":\"n\"},\"discussions\":{}}",
        ));
        let mut items = vec![change("y", 0, 2), change("x", 0, 2), change("z", 0, 2), change("w", 0, 2)];
        overlay_changes_order(&mut items, &board);
        assert_eq!(names(&items), ["z", "w", "x", "y"]);
    }

    #[test]
    fn equal_ranks_break_ties_by_name() {
        // board-card-order Example「同值以名称决断」：beta 与 alpha 同 rank n
        // → alpha 在前，跨机器确定。
        let board = BoardOrderDoc::from_content(Some(
            "{\"changes\":{\"beta\":\"n\",\"alpha\":\"n\"},\"discussions\":{}}",
        ));
        let mut items = vec![change("beta", 0, 2), change("alpha", 0, 2)];
        overlay_changes_order(&mut items, &board);
        assert_eq!(names(&items), ["alpha", "beta"]);
    }

    #[test]
    fn multiple_unranked_keep_the_server_order_among_themselves() {
        let board = BoardOrderDoc::from_content(Some("{\"changes\":{\"m\":\"n\"},\"discussions\":{}}"));
        let mut items = vec![change("delta", 0, 2), change("bravo", 0, 2), change("m", 0, 2)];
        overlay_changes_order(&mut items, &board);
        assert_eq!(names(&items), ["delta", "bravo", "m"], "缺 rank 卡维持 server 回传序置顶");
    }

    #[test]
    fn absent_board_resource_leaves_the_server_order_untouched() {
        // 规格 Scenario「无 board resource 时行为不变」：逐项一致。
        let mut items = vec![change("c", 1, 2), change("a", 0, 2), change("b", 2, 2)];
        let before = names(&items).into_iter().map(String::from).collect::<Vec<_>>();
        let board = BoardOrderDoc::from_content(None);
        overlay_changes_order(&mut items, &board);
        assert_eq!(names(&items), before.iter().map(String::as_str).collect::<Vec<_>>());
    }

    #[test]
    fn corrupt_board_resource_is_treated_as_all_unranked() {
        // 规格 Scenario「坏文档退回回退序」＋ design 决策 6：非法 JSON／非预期
        // 形状＝全员缺 rank，照常渲染不失效。
        for corrupt in ["not json at all {{{", "[1,2,3]", "{\"changes\":\"not-a-map\"}"] {
            let mut items = vec![change("c", 0, 2), change("a", 0, 2)];
            let board = BoardOrderDoc::from_content(Some(corrupt));
            overlay_changes_order(&mut items, &board);
            assert_eq!(names(&items), ["c", "a"], "corrupt content {corrupt:?} falls back");
        }
    }

    #[test]
    fn discussions_overlay_follows_the_same_semantics() {
        let board = BoardOrderDoc::from_content(Some(
            "{\"changes\":{},\"discussions\":{\"delta\":\"b\",\"charlie\":\"n\",\"echo\":\"n\"}}",
        ));
        let mut items = vec![
            discussion("charlie"),
            discussion("zulu"),
            discussion("echo"),
            discussion("delta"),
        ];
        overlay_discussions_order(&mut items, &board);
        let slugs: Vec<&str> = items.iter().map(|i| i.slug.as_str()).collect();
        // zulu 缺 rank 置顶；delta(b) < charlie(n)==echo(n) 同值以 slug 决断。
        assert_eq!(slugs, ["zulu", "delta", "charlie", "echo"]);
    }
}

#[cfg(test)]
mod plan_merge_tests {
    use super::board_order_tests::change;
    use super::{merge_plan, RemoteChangeList};
    use specseal_desktop_core::query::PLAN_FIELDS;
    use specseal_protocol::query::{BoardOrderDoc, PlanChangeEntry, PlanResponse, PlanUnpromotedCut};
    use specseal_remote::RemoteError;

    pub(super) fn entry(name: &str, wave: usize, depends_on: &[&str], blocked_by: &[&str]) -> PlanChangeEntry {
        PlanChangeEntry {
            name: name.into(),
            wave,
            stage: "proposed".into(),
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
            overlaps: Vec::new(),
            blocked_by: blocked_by.iter().map(|s| s.to_string()).collect(),
            ready: blocked_by.is_empty(),
            requirement_overlap: Vec::new(),
            archive_after: Vec::new(),
        }
    }

    pub(super) fn plan(entries: Vec<PlanChangeEntry>) -> PlanResponse {
        PlanResponse {
            waves: Vec::new(),
            changes: entries,
            next: None,
            skipped: Vec::new(),
            unpromoted_cuts: Vec::new(),
            strict_overlap: false,
        }
    }

    fn failure(status: Option<u16>, reason: Option<&str>, message: &str) -> RemoteError {
        RemoteError {
            message: message.into(),
            reason: reason.map(str::to_string),
            status,
            evidence: None,
        }
    }

    fn names(list: &RemoteChangeList) -> Vec<&str> {
        list.changes.iter().map(|c| c.summary.name.as_str()).collect()
    }

    /// board 的 rank 让 b 排在 a 前面。
    fn board() -> BoardOrderDoc {
        BoardOrderDoc::from_content(Some(r#"{"changes":{"b":"b","a":"f"}}"#))
    }

    #[test]
    fn the_plan_decides_the_order_and_carries_the_schedule_fields() {
        // 规格「remote 变更清单的调度字段」：plan 的配置序优先于 board overlay。
        let list = merge_plan(
            vec![change("a", 0, 0), change("b", 0, 0)],
            &board(),
            Ok(plan(vec![entry("a", 1, &[], &[]), entry("b", 2, &["a"], &["a"])])),
        );
        assert_eq!(names(&list), ["a", "b"]);
        assert_eq!(list.plan_error, None);
        let b = list.changes[1].schedule.as_ref().expect("the plan's row rides along");
        assert_eq!(b["wave"], 2);
        assert_eq!(b["dependsOn"], serde_json::json!(["a"]));
        assert_eq!(b["blockedBy"], serde_json::json!(["a"]));
        assert_eq!(b["overlaps"], serde_json::json!([]));
        // 只搬调度字段：plan 列的 name、stage、ready 不叠到清单项上。
        let keys: Vec<&str> = b.keys().map(String::as_str).collect();
        assert_eq!(keys.len(), PLAN_FIELDS.len(), "{keys:?}");
    }

    #[test]
    fn changes_the_plan_does_not_list_trail_in_server_order_without_fields() {
        // plan 与清单是两次请求：之间添加或坏 meta 被 plan 略过的项落在末尾。
        let list = merge_plan(
            vec![change("a", 0, 0), change("b", 0, 0), change("c", 0, 0), change("d", 0, 0)],
            &BoardOrderDoc::default(),
            Ok(plan(vec![entry("c", 1, &[], &[]), entry("a", 1, &[], &[])])),
        );
        assert_eq!(names(&list), ["c", "a", "b", "d"]);
        assert_eq!(list.changes[2].schedule, None);
        assert_eq!(list.changes[3].schedule, None);
    }

    #[test]
    fn a_409_cycle_falls_back_to_the_board_overlay_with_the_message() {
        // 规格 Scenario「remote 成环退回」。
        let list = merge_plan(
            vec![change("a", 0, 0), change("b", 0, 0)],
            &board(),
            Err(failure(Some(409), Some("refused"), "dependency cycle: a -> b -> a")),
        );
        assert_eq!(names(&list), ["b", "a"]);
        assert_eq!(list.plan_error.as_deref(), Some("dependency cycle: a -> b -> a"));
        assert!(list.changes.iter().all(|c| c.schedule.is_none()));
    }

    #[test]
    fn an_old_server_or_a_lost_connection_falls_back_silently() {
        // 规格 Scenario「旧 server 退回」：404、连接失败、5xx 都不打扰用户。
        for error in [
            failure(Some(404), Some("not_found"), "resource not found"),
            failure(None, None, "server unreachable"),
            failure(Some(500), None, "server unavailable"),
        ] {
            let list = merge_plan(vec![change("a", 0, 0), change("b", 0, 0)], &board(), Err(error));
            assert_eq!(names(&list), ["b", "a"], "board overlay order");
            assert_eq!(list.plan_error, None);
            assert!(list.changes.iter().all(|c| c.schedule.is_none()));
        }
    }

    #[test]
    fn the_payload_is_flat_camel_case_and_omits_absent_fields() {
        let with_plan = merge_plan(
            vec![change("a", 1, 2)],
            &BoardOrderDoc::default(),
            Ok(plan(vec![entry("a", 1, &[], &[])])),
        );
        let json = serde_json::to_value(&with_plan).unwrap();
        assert_eq!(json["planError"], serde_json::Value::Null);
        assert_eq!(json["changes"][0]["name"], "a");
        assert_eq!(json["changes"][0]["completedTasks"], 1);
        assert_eq!(json["changes"][0]["blockedBy"], serde_json::json!([]));
        for field in PLAN_FIELDS {
            assert!(json["changes"][0].get(field).is_some(), "{field} carried");
        }

        let without = merge_plan(
            vec![change("a", 1, 2)],
            &BoardOrderDoc::default(),
            Err(failure(Some(404), None, "")),
        );
        let json = serde_json::to_value(&without).unwrap();
        for field in PLAN_FIELDS {
            assert!(json["changes"][0].get(field).is_none(), "{field} omitted");
        }
    }

    #[test]
    fn merge_plan_old_server_yields_empty_new_fields() {
        // 规格 Scenario「旧 server 缺新字段读作空数组」：plan 回应每项只有七键（in-process
        // server 一定回九键，旧 server 只能在这层以真实回应本文仿真）——两个新字段沿
        // wire 类型的 default 成为空数组而非缺席，wave 与 blockedBy 照常。
        let old_server: PlanResponse = serde_json::from_str(
            r#"{"waves":[{"index":1,"changes":["a"]},{"index":2,"changes":["b"]}],
                "changes":[
                  {"name":"a","wave":1,"stage":"proposed","dependsOn":[],"overlaps":[],"blockedBy":[],"ready":true},
                  {"name":"b","wave":2,"stage":"proposed","dependsOn":["a"],"overlaps":[],"blockedBy":["a"],"ready":false}
                ],
                "next":"a","skipped":[]}"#,
        )
        .expect("an old server's plan still parses");
        let list = merge_plan(
            vec![change("a", 0, 0), change("b", 0, 0)],
            &BoardOrderDoc::default(),
            Ok(old_server),
        );
        let json = serde_json::to_value(&list).unwrap();
        let b = &json["changes"][1];
        assert_eq!(b["name"], "b");
        assert_eq!(b["wave"], 2, "{b}");
        assert_eq!(b["blockedBy"], serde_json::json!(["a"]), "{b}");
        for item in json["changes"].as_array().unwrap() {
            assert_eq!(item["requirementOverlap"], serde_json::json!([]), "{item}");
            assert_eq!(item["archiveAfter"], serde_json::json!([]), "{item}");
        }
        // 旧 server 的 plan 回应没有 unpromotedCuts 键：顶层读作空数组，next 照搬。
        assert_eq!(list.next.as_deref(), Some("a"));
        assert!(list.unpromoted_cuts.is_empty());
        assert_eq!(json["unpromotedCuts"], serde_json::json!([]), "{json}");
    }

    fn panel_cut() -> PlanUnpromotedCut {
        PlanUnpromotedCut {
            discussion: "panel".into(),
            cut: "cut 3".into(),
            title: "路线图".into(),
            changes: vec!["add-z".into()],
            unpromoted: vec!["add-z".into()],
        }
    }

    #[test]
    fn merge_plan_carries_the_next_and_unpromoted_cuts() {
        // 规格 Scenario「remote 清单带 next 与尚未转出的刀」：两栏逐栏搬运自 GET /plan，
        // 串行化为顶层的 next 与 unpromotedCuts（五键 camelCase）。
        let mut response = plan(vec![entry("add-a", 1, &[], &[])]);
        response.next = Some("add-a".into());
        response.unpromoted_cuts = vec![panel_cut()];
        let list = merge_plan(vec![change("add-a", 0, 0)], &BoardOrderDoc::default(), Ok(response));
        assert_eq!(list.next.as_deref(), Some("add-a"));
        assert_eq!(list.unpromoted_cuts, [panel_cut()]);
        let json = serde_json::to_value(&list).unwrap();
        assert_eq!(json["next"], "add-a");
        assert_eq!(
            json["unpromotedCuts"],
            serde_json::json!([{
                "discussion": "panel",
                "cut": "cut 3",
                "title": "路线图",
                "changes": ["add-z"],
                "unpromoted": ["add-z"],
            }])
        );
    }

    #[test]
    fn merge_plan_errors_clear_the_next_and_unpromoted_cuts() {
        // 规格「remote 变更清单的调度字段」：409（成环）与其他错误（404、连接失败）
        // 时 next 为 null、unpromotedCuts 为空数组——两键照样出现在 payload。
        for error in [
            failure(Some(409), Some("refused"), "dependency cycle: a -> b -> a"),
            failure(Some(404), Some("not_found"), "resource not found"),
            failure(None, None, "server unreachable"),
        ] {
            let list = merge_plan(vec![change("a", 0, 0)], &board(), Err(error));
            assert_eq!(list.next, None);
            assert!(list.unpromoted_cuts.is_empty());
            let json = serde_json::to_value(&list).unwrap();
            assert!(json.get("next").is_some_and(serde_json::Value::is_null), "{json}");
            assert_eq!(json["unpromotedCuts"], serde_json::json!([]), "{json}");
        }
    }
}

#[cfg(test)]
mod board_reorder_tests {
    use super::board_order_tests::{change, discussion};
    use super::plan_merge_tests::{entry, plan};
    use super::{reorder_via, BoardOrderDoc, BoardSnapshot};
    use specseal_protocol::query::PlanSkipped;
    use specseal_remote::RemoteError;
    use std::cell::{Cell, RefCell};

    fn conflict() -> RemoteError {
        RemoteError {
            message: "revision 冲突".into(),
            reason: Some("revision_conflict".into()),
            status: Some(409),
            evidence: None,
        }
    }

    /// 依 snapshot 产生 read/put 假 IO；记录每次 put 的 (content, revision)。
    struct FakeIo {
        snapshots: RefCell<Vec<BoardSnapshot>>,
        reads: Cell<usize>,
        puts: RefCell<Vec<(String, u64)>>,
        /// 依调用序回应 put：true＝成功、false＝409。
        put_plan: Vec<bool>,
    }

    impl FakeIo {
        fn new(snapshots: Vec<BoardSnapshot>, put_plan: Vec<bool>) -> FakeIo {
            FakeIo {
                snapshots: RefCell::new(snapshots),
                reads: Cell::new(0),
                puts: RefCell::new(Vec::new()),
                put_plan,
            }
        }

        fn run(
            &self,
            kind: &str,
            id: &str,
            prev: Option<&str>,
            next: Option<&str>,
        ) -> Result<(), RemoteError> {
            reorder_via(
                || {
                    let index = self.reads.get();
                    self.reads.set(index + 1);
                    let snapshots = self.snapshots.borrow();
                    Ok(snapshots[index.min(snapshots.len() - 1)].clone())
                },
                |content, revision| {
                    let attempt = self.puts.borrow().len();
                    self.puts.borrow_mut().push((content.to_string(), revision));
                    if self.put_plan[attempt] {
                        Ok(())
                    } else {
                        Err(conflict())
                    }
                },
                kind,
                id,
                prev,
                next,
            )
        }
    }

    fn snapshot(
        changes: Vec<specseal_protocol::query::ChangeSummary>,
        discussions: Vec<specseal_protocol::query::DiscussionInfo>,
        content: Option<&str>,
        revision: u64,
    ) -> BoardSnapshot {
        BoardSnapshot {
            changes,
            discussions,
            content: content.map(String::from),
            revision,
            plan: None,
        }
    }

    #[test]
    fn a_column_whose_ranks_disagree_with_the_plan_order_is_respread_before_the_move() {
        // 规格 Scenario「rank 序与显示序不一致时整栏重派」：add-c 依赖 add-a 但
        // rank 较小，plan 显示序 add-a、add-c、add-x；把 add-x 拖到两者之间。
        let mut snap = snapshot(
            vec![change("add-a", 0, 4), change("add-c", 0, 4), change("add-x", 0, 4)],
            vec![],
            Some(r#"{"changes":{"add-c":"d","add-a":"h","add-x":"p"},"discussions":{}}"#),
            3,
        );
        snap.plan = Some(plan(vec![
            entry("add-a", 1, &[], &[]),
            entry("add-c", 1, &["add-a"], &[]),
            entry("add-x", 1, &[], &[]),
        ]));
        let io = FakeIo::new(vec![snap], vec![true]);
        io.run("change", "add-x", Some("add-a"), Some("add-c")).expect("reorder lands");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        let (a, x, c) = (&doc.changes["add-a"], &doc.changes["add-x"], &doc.changes["add-c"]);
        assert!(a < x && x < c, "重派后 add-x 落在两者之间：{a} < {x} < {c}");
    }

    #[test]
    fn a_drag_across_a_declared_dependency_is_refused_without_a_put() {
        // 规格 Scenario「remote 拖排违反依赖不发 PUT」：消息与 local 同一句。
        let mut snap = snapshot(
            vec![change("add-a", 0, 4), change("add-b", 0, 4)],
            vec![],
            Some(r#"{"changes":{"add-a":"f","add-b":"n"},"discussions":{}}"#),
            3,
        );
        snap.plan = Some(plan(vec![entry("add-a", 1, &[], &[]), entry("add-b", 1, &["add-a"], &[])]));
        let io = FakeIo::new(vec![snap.clone()], vec![true]);
        let error = io.run("change", "add-b", None, Some("add-a")).expect_err("crossing is refused");
        assert_eq!(error.message, "cannot move 'add-b' there: it depends on add-a");
        assert!(io.puts.borrow().is_empty(), "a refused move sends no PUT");

        // 把前置拖到依赖者之后同样被挡。
        let io = FakeIo::new(vec![snap], vec![true]);
        let error = io.run("change", "add-a", Some("add-b"), None).expect_err("crossing is refused");
        assert_eq!(error.message, "cannot move 'add-a' there: add-b depend on it");
        assert!(io.puts.borrow().is_empty());
    }

    #[test]
    fn a_skipped_prerequisite_takes_no_part_in_the_dependency_check() {
        // 引擎视对 plan 略过的卡（坏 meta）的依赖为已满足，与本机拖排（引擎 move_rank 的
        // 依赖检查）的判定范围相同：add-b 声明依赖排在栏尾的 add-x，桌面收到把 add-b 移到栏顶的写回请求时
        // 照常写回。
        let mut snap = snapshot(
            vec![change("add-a", 0, 4), change("add-b", 0, 4), change("add-x", 0, 4)],
            vec![],
            Some(r#"{"changes":{"add-a":"f","add-b":"n","add-x":"t"},"discussions":{}}"#),
            3,
        );
        let mut skipping = plan(vec![entry("add-a", 1, &[], &[]), entry("add-b", 1, &["add-x"], &[])]);
        skipping.skipped.push(PlanSkipped { change: "add-x".into(), reason: "bad yaml".into() });
        snap.plan = Some(skipping);
        let io = FakeIo::new(vec![snap], vec![true]);
        io.run("change", "add-b", None, Some("add-a")).expect("a skipped prerequisite blocks nothing");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        assert!(doc.changes["add-b"] < doc.changes["add-a"], "add-b 落在栏顶");
    }

    #[test]
    fn a_drop_after_a_trailing_skipped_card_lands_at_the_column_bottom() {
        // plan 略过的卡显示在栏尾，前端把它当成上方邻居送出（prevId＝add-x、nextId＝null）：
        // 它留在栏内参与落点计算，新键排在它之后，不被当成空栏的首键。
        let mut snap = snapshot(
            vec![change("add-a", 0, 4), change("add-b", 0, 4), change("add-x", 0, 4)],
            vec![],
            Some(r#"{"changes":{"add-a":"i","add-b":"q","add-x":"t"},"discussions":{}}"#),
            3,
        );
        let mut skipping = plan(vec![entry("add-a", 1, &[], &[]), entry("add-b", 1, &[], &[])]);
        skipping.skipped.push(PlanSkipped { change: "add-x".into(), reason: "bad yaml".into() });
        snap.plan = Some(skipping);
        let io = FakeIo::new(vec![snap], vec![true]);
        io.run("change", "add-a", Some("add-x"), None).expect("reorder lands");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        let (a, b, x) = (&doc.changes["add-a"], &doc.changes["add-b"], &doc.changes["add-x"]);
        assert!(b < x && x < a, "add-a 落在栏底：{b} < {x} < {a}");
    }

    #[test]
    fn dragging_a_skipped_card_is_refused_with_the_local_line_and_no_put() {
        // 被拖卡本身被 plan 略过（坏 meta）：写进 rank 也会被显示序排回栏尾，与本地写坏 meta
        // 被拒同构——回同一句 `invalid …/.meta.yaml: <原因>`，不发 PUT。
        let mut snap = snapshot(
            vec![change("add-a", 0, 4), change("add-x", 0, 4)],
            vec![],
            Some(r#"{"changes":{"add-a":"i","add-x":"t"},"discussions":{}}"#),
            3,
        );
        let mut skipping = plan(vec![entry("add-a", 1, &[], &[])]);
        skipping.skipped.push(PlanSkipped { change: "add-x".into(), reason: "bad yaml".into() });
        snap.plan = Some(skipping);
        let io = FakeIo::new(vec![snap], vec![true]);
        let error = io.run("change", "add-x", None, Some("add-a")).expect_err("a skipped card cannot move");
        assert_eq!(error.message, "invalid specseal/changes/add-x/.meta.yaml: bad yaml");
        assert_eq!(error.reason.as_deref(), Some("invalid_config"));
        assert!(io.puts.borrow().is_empty(), "a refused move sends no PUT");
    }

    #[test]
    fn without_a_plan_the_dependency_check_is_skipped() {
        // 旧 server（plan 不可得）：没有 dependsOn 图可查，照常写回。
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("add-a", 0, 4), change("add-b", 0, 4)],
                vec![],
                Some(r#"{"changes":{"add-a":"f","add-b":"n"},"discussions":{}}"#),
                3,
            )],
            vec![true],
        );
        io.run("change", "add-b", None, Some("add-a")).expect("no plan, no check");
        assert_eq!(io.puts.borrow().len(), 1);
    }

    #[test]
    fn unranked_column_is_backfilled_into_the_board_resource_only() {
        // design 决策 5：栏内缺 rank → 依当前显示序整栏补章，等距键只落在
        // board resource 图内；落点取邻居中点。
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("a", 0, 4), change("b", 0, 4), change("c", 0, 4)],
                vec![],
                None,
                5,
            )],
            vec![true],
        );
        io.run("change", "c", Some("a"), Some("b")).expect("reorder lands");

        let puts = io.puts.borrow();
        assert_eq!(puts.len(), 1, "恰一次 PUT 全文");
        let (content, revision) = &puts[0];
        assert_eq!(*revision, 5, "If-Match 带读到的 scope revision");
        let doc = BoardOrderDoc::from_content(Some(content));
        let (a, b, c) = (&doc.changes["a"], &doc.changes["b"], &doc.changes["c"]);
        assert!(a < c && c < b, "c 落在 a 与 b 之间：{a} < {c} < {b}");
        assert!(doc.discussions.is_empty(), "补章只涵盖被拖卡所在栏");
    }

    #[test]
    fn backfill_covers_only_the_dragged_cards_column() {
        // 栏推导与前端 changeStage 同构：proposed(0) 与 ready(全完成) 分栏，
        // 拖 proposed 卡不为 ready 卡补章。
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("done", 4, 4), change("a", 0, 4), change("b", 0, 4)],
                vec![],
                None,
                3,
            )],
            vec![true],
        );
        io.run("change", "b", None, Some("a")).expect("reorder lands");
        let puts = io.puts.borrow();
        let doc = BoardOrderDoc::from_content(Some(&puts[0].0));
        assert!(!doc.changes.contains_key("done"), "他栏的卡不被补章触碰");
        assert!(doc.changes["b"] < doc.changes["a"], "b 落在 a 之前（栏顶）");
    }

    #[test]
    fn vanished_neighbors_are_open_ends_and_inverted_ranks_drop_the_upper_bound() {
        // 规格「拖排写回以全文 CAS 与一次重试收敛」：消失的邻居视开放端、
        // 邻居现值逆序时弃上界保底——沿本地 neighbor_midpoint 语意。
        let board = "{\"changes\":{\"a\":\"f\",\"b\":\"n\",\"drag\":\"t\"},\"discussions\":{}}";
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("a", 0, 4), change("b", 0, 4), change("drag", 0, 4)],
                vec![],
                Some(board),
                7,
            )],
            vec![true],
        );
        // prev 指向已消失的卡（开放端＝栏顶）、next 为 a(f) → key < f。
        io.run("change", "drag", Some("ghost"), Some("a")).expect("reorder lands");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        assert!(doc.changes["drag"].as_str() < "f", "消失的 prev 视为栏顶开放端");

        // 逆序邻居（prev=b(n)、next=a(f)，n > f）→ 弃上界：key > n。
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("a", 0, 4), change("b", 0, 4), change("drag", 0, 4)],
                vec![],
                Some(board),
                7,
            )],
            vec![true],
        );
        io.run("change", "drag", Some("b"), Some("a")).expect("reorder lands");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        assert!(doc.changes["drag"].as_str() > "n", "逆序邻居弃上界保底");
    }

    #[test]
    fn entries_absent_from_the_current_lists_are_pruned_on_rewrite() {
        // 规格 Scenario「已封存卡的条目被修剪」：PUT 全文不含不在现行清单
        // 的条目——changes 与 discussions 两段图皆修剪。
        let board = "{\"changes\":{\"gone\":\"d\",\"a\":\"f\",\"b\":\"n\"},\
                     \"discussions\":{\"stale\":\"g\",\"topic\":\"m\"}}";
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("a", 0, 4), change("b", 0, 4)],
                vec![discussion("topic")],
                Some(board),
                9,
            )],
            vec![true],
        );
        io.run("change", "a", Some("b"), None).expect("reorder lands");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        assert!(!doc.changes.contains_key("gone"), "封存变更的条目被修剪");
        assert!(!doc.discussions.contains_key("stale"), "孤儿讨论条目一并修剪");
        assert!(doc.discussions.contains_key("topic"), "现行清单内的条目保留");
    }

    #[test]
    fn a_conflict_rereads_recomputes_and_retries_exactly_once() {
        // 规格 Scenario「409 重读后落位」：重读 → 重算 → 重试恰一次成功，
        // 第二次 PUT 带新 revision 且落点基于他人已写入的新 board。
        let first = snapshot(
            vec![change("a", 0, 4), change("b", 0, 4), change("drag", 0, 4)],
            vec![],
            Some("{\"changes\":{\"a\":\"f\",\"b\":\"n\",\"drag\":\"t\"},\"discussions\":{}}"),
            5,
        );
        let second = snapshot(
            vec![change("a", 0, 4), change("b", 0, 4), change("drag", 0, 4)],
            vec![],
            Some("{\"changes\":{\"a\":\"c\",\"b\":\"x\",\"drag\":\"t\"},\"discussions\":{}}"),
            8,
        );
        let io = FakeIo::new(vec![first, second], vec![false, true]);
        io.run("change", "drag", Some("a"), Some("b")).expect("retry lands");

        assert_eq!(io.reads.get(), 2, "409 后重读一次");
        let puts = io.puts.borrow();
        assert_eq!(puts.len(), 2, "重试恰一次");
        assert_eq!(puts[1].1, 8, "重试带重读后的新 revision");
        let doc = BoardOrderDoc::from_content(Some(&puts[1].0));
        let key = doc.changes["drag"].as_str();
        assert!("c" < key && key < "x", "落点基于重读后的邻居现值：c < {key} < x");
    }

    #[test]
    fn a_second_conflict_surfaces_the_error_without_a_third_attempt() {
        // 规格 Scenario「重试仍败不留假象」：再败回错误（机器可判），调用端
        // 据此刷新 server 现况；绝不第三次尝试。
        let base = snapshot(
            vec![change("a", 0, 4), change("drag", 0, 4)],
            vec![],
            None,
            5,
        );
        let io = FakeIo::new(vec![base.clone(), base], vec![false, false]);
        let error = io.run("change", "drag", Some("a"), None).expect_err("both attempts conflict");
        assert_eq!(error.reason.as_deref(), Some("revision_conflict"));
        assert_eq!(io.puts.borrow().len(), 2, "重试上限恰一次，无第三次 PUT");
    }

    #[test]
    fn a_dragged_card_missing_from_the_list_is_an_error_without_any_put() {
        let io = FakeIo::new(
            vec![snapshot(vec![change("a", 0, 4)], vec![], None, 5)],
            vec![true],
        );
        io.run("change", "ghost", None, None).expect_err("unknown card is refused");
        assert!(io.puts.borrow().is_empty(), "查无此卡不产生任何写入");
    }

    #[test]
    fn discussions_reorder_writes_the_discussions_map() {
        let io = FakeIo::new(
            vec![snapshot(
                vec![],
                vec![discussion("alpha"), discussion("beta"), discussion("gamma")],
                None,
                4,
            )],
            vec![true],
        );
        io.run("discussion", "gamma", Some("alpha"), Some("beta")).expect("reorder lands");
        let doc = BoardOrderDoc::from_content(Some(&io.puts.borrow()[0].0));
        let (a, b, g) = (
            &doc.discussions["alpha"],
            &doc.discussions["beta"],
            &doc.discussions["gamma"],
        );
        assert!(a < g && g < b, "gamma 落在 alpha 与 beta 之间");
        assert!(doc.changes.is_empty(), "变更图不被讨论拖排触碰");
    }

    #[test]
    fn corrupt_board_content_is_rebuilt_by_the_next_reorder() {
        // 规格 Scenario「坏文档退回回退序」后半：下一次成功拖排重建合法文档。
        let io = FakeIo::new(
            vec![snapshot(
                vec![change("a", 0, 4), change("b", 0, 4)],
                vec![],
                Some("not json at all {{{"),
                6,
            )],
            vec![true],
        );
        io.run("change", "b", None, Some("a")).expect("reorder lands");
        let text = &io.puts.borrow()[0].0;
        let doc: BoardOrderDoc = serde_json::from_str(text).expect("重建后为合法 JSON 形状");
        assert!(doc.changes["b"] < doc.changes["a"]);
    }
}

#[cfg(test)]
mod migration_bundle_tests {
    use super::{
        adopt_remote_workspace_with, build_import_bundle, finalize_local_migration_with, migratable_spec_dir,
    };
    use specseal_protocol::query::ImportDocumentId;
    use std::collections::BTreeMap;
    use std::path::Path;
    use tempfile::TempDir;

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().expect("fixture parent")).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn complete_workspace() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "openspec/config.yaml",
            "schema: spec-driven\nlocale: tw\n",
        );
        write(root.path(), "openspec/LANGUAGE.md", "TeamStore: 团队保存\n");
        write(
            root.path(),
            "openspec/changes/active-change/.openspec.yaml",
            "schema: spec-driven\ncreated: 2026-07-21\n",
        );
        write(
            root.path(),
            "openspec/changes/active-change/proposal.md",
            "## Why\n\nActive proposal.\n",
        );
        write(
            root.path(),
            "openspec/changes/active-change/design.md",
            "## Context\n\nActive design.\n",
        );
        write(
            root.path(),
            "openspec/changes/active-change/tasks.md",
            "- [ ] 1.1 Active task\n",
        );
        write(
            root.path(),
            "openspec/changes/active-change/specs/payments/spec.md",
            "## ADDED Requirements\n\n### Requirement: Active payment\n",
        );
        write(
            root.path(),
            "openspec/specs/accounts/spec.md",
            "# accounts Specification\n\nCanonical accounts.\n",
        );
        write(
            root.path(),
            "openspec/discussions/live-plan.md",
            "---\ntopic: Live plan\nslug: live-plan\nstatus: open\ncreated: 2026-07-21\n---\n\nLive discussion.\n",
        );
        write(
            root.path(),
            "openspec/discussions/archive/2026-07-20-old-plan.md",
            "---\ntopic: Old plan\nslug: old-plan\nstatus: concluded\ncreated: 2026-07-20\n---\n\nArchived discussion.\n",
        );
        write(
            root.path(),
            "openspec/changes/archive/2026-07-20-old-change/.openspec.yaml",
            "schema: spec-driven\ncreated: 2026-07-20\n",
        );
        write(
            root.path(),
            "openspec/changes/archive/2026-07-20-old-change/proposal.md",
            "## Why\n\nArchived proposal.\n",
        );
        write(
            root.path(),
            "openspec/changes/archive/2026-07-20-old-change/tasks.md",
            "- [x] 1.1 Archived task\n",
        );
        write(
            root.path(),
            "openspec/changes/archive/2026-07-20-old-change/specs/payments/spec.md",
            "## ADDED Requirements\n\n### Requirement: Archived payment\n",
        );
        root
    }

    #[test]
    fn bundle_contains_every_local_workspace_document_with_exact_content() {
        let root = complete_workspace();
        let bundle = build_import_bundle(root.path(), "demo", "backend")
            .expect("complete local workspace builds");
        assert_eq!(bundle.format_version, 1);
        assert_eq!(bundle.scope.project, "demo");
        assert_eq!(bundle.scope.repo, "backend");
        assert_eq!(bundle.project_revision, 0);

        let documents: BTreeMap<ImportDocumentId, String> = bundle
            .documents
            .into_iter()
            .map(|document| (document.document, document.content))
            .collect();
        let expected = BTreeMap::from([
            (
                ImportDocumentId::ChangeMeta {
                    change: "active-change".into(),
                },
                "schema: spec-driven\ncreated: 2026-07-21\n".into(),
            ),
            (
                ImportDocumentId::ChangeArtifact {
                    change: "active-change".into(),
                    artifact: "proposal.md".into(),
                },
                "## Why\n\nActive proposal.\n".into(),
            ),
            (
                ImportDocumentId::ChangeArtifact {
                    change: "active-change".into(),
                    artifact: "design.md".into(),
                },
                "## Context\n\nActive design.\n".into(),
            ),
            (
                ImportDocumentId::ChangeArtifact {
                    change: "active-change".into(),
                    artifact: "tasks.md".into(),
                },
                "- [ ] 1.1 Active task\n".into(),
            ),
            (
                ImportDocumentId::ChangeArtifact {
                    change: "active-change".into(),
                    artifact: "specs/payments/spec.md".into(),
                },
                "## ADDED Requirements\n\n### Requirement: Active payment\n".into(),
            ),
            (
                ImportDocumentId::CanonicalSpec {
                    capability: "accounts".into(),
                },
                "# accounts Specification\n\nCanonical accounts.\n".into(),
            ),
            (
                ImportDocumentId::Discussion {
                    slug: "live-plan".into(),
                    archived: false,
                },
                "---\ntopic: Live plan\nslug: live-plan\nstatus: open\ncreated: 2026-07-21\n---\n\nLive discussion.\n".into(),
            ),
            (
                ImportDocumentId::Discussion {
                    slug: "old-plan".into(),
                    archived: true,
                },
                "---\ntopic: Old plan\nslug: old-plan\nstatus: concluded\ncreated: 2026-07-20\n---\n\nArchived discussion.\n".into(),
            ),
            (
                // 旧文件名的已封存数据档一律以 .meta.yaml 为键上传（desktop-spec-dir-migration D5）。
                ImportDocumentId::ArchivedChange {
                    change: "2026-07-20-old-change".into(),
                    doc: ".meta.yaml".into(),
                },
                "schema: spec-driven\ncreated: 2026-07-20\n".into(),
            ),
            (
                ImportDocumentId::ArchivedChange {
                    change: "2026-07-20-old-change".into(),
                    doc: "proposal.md".into(),
                },
                "## Why\n\nArchived proposal.\n".into(),
            ),
            (
                ImportDocumentId::ArchivedChange {
                    change: "2026-07-20-old-change".into(),
                    doc: "tasks.md".into(),
                },
                "- [x] 1.1 Archived task\n".into(),
            ),
            (
                ImportDocumentId::ArchivedChange {
                    change: "2026-07-20-old-change".into(),
                    doc: "specs/payments/spec.md".into(),
                },
                "## ADDED Requirements\n\n### Requirement: Archived payment\n".into(),
            ),
            (
                ImportDocumentId::WorkflowConfig,
                "schema: spec-driven\nlocale: tw\n".into(),
            ),
            (
                ImportDocumentId::Language,
                "TeamStore: 团队保存\n".into(),
            ),
        ]);
        assert_eq!(documents, expected);
    }

    #[test]
    fn corrupt_change_metadata_aborts_the_bundle_and_names_the_file() {
        let root = complete_workspace();
        write(
            root.path(),
            "openspec/changes/active-change/.openspec.yaml",
            "schema: [unterminated\n",
        );

        let error = build_import_bundle(root.path(), "demo", "backend")
            .expect_err("corrupt metadata must fail closed");
        assert!(
            error.contains("openspec/changes/active-change/.openspec.yaml"),
            "error names the corrupt metadata file: {error}"
        );
    }

    #[test]
    fn successful_conversion_renames_the_local_tree_before_writing_the_marker() {
        let root = complete_workspace();
        let marker = root.path().join(".specseal.yaml");
        let backup = finalize_local_migration_with(
            root.path(),
            "openspec",
            "https://spec.example.test",
            "demo",
            "backend",
            "2026-07-21",
            |from, to| {
                assert!(from.is_dir(), "local truth exists until the rename");
                assert!(!marker.exists(), "marker is not written before the backup");
                std::fs::rename(from, to)
            },
        )
        .expect("conversion succeeds");

        assert_eq!(backup, root.path().join("openspec.migrated-2026-07-21"));
        assert!(!root.path().join("openspec").exists());
        assert!(backup.join("changes/active-change/proposal.md").is_file());
        let marker = std::fs::read_to_string(marker).expect("remote marker");
        assert!(marker.contains("https://spec.example.test/api/specseal/v1/projects/demo"));
        assert!(marker.contains("repo: backend"));
    }

    #[test]
    fn an_existing_dated_backup_uses_the_next_available_sequence() {
        let root = complete_workspace();
        std::fs::create_dir(root.path().join("openspec.migrated-2026-07-21")).unwrap();
        std::fs::create_dir(root.path().join("openspec.migrated-2026-07-21-2")).unwrap();

        let backup = finalize_local_migration_with(
            root.path(),
            "openspec",
            "https://spec.example.test",
            "demo",
            "backend",
            "2026-07-21",
            |from, to| std::fs::rename(from, to),
        )
        .expect("conversion succeeds");
        assert_eq!(backup, root.path().join("openspec.migrated-2026-07-21-3"));
        assert!(backup.is_dir());
    }

    #[test]
    fn the_backup_is_named_after_the_actual_folder_and_keeps_the_sequence_rule() {
        // spec Scenario「备份目录依实际文件夹命名」。
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "specseal/changes/demo/proposal.md", "## Why\n");
        std::fs::create_dir(root.path().join("specseal.migrated-2026-11-02")).unwrap();

        let backup = finalize_local_migration_with(
            root.path(),
            "specseal",
            "https://spec.example.test",
            "demo",
            "backend",
            "2026-11-02",
            |from, to| std::fs::rename(from, to),
        )
        .expect("conversion succeeds");
        assert_eq!(backup, root.path().join("specseal.migrated-2026-11-02-2"));
        assert!(!root.path().join("specseal").exists());
        assert!(backup.join("changes/demo/proposal.md").is_file());
    }

    #[test]
    fn only_an_explicit_custom_spec_folder_is_refused() {
        // spec「新旧缺省文件夹都可迁移到远程」：缺省与旧布局放行，自订文件夹在任何远程写入前被拒。
        let workspace = |name: &str| specseal_core::workspace::Workspace {
            root: std::path::PathBuf::from("/p"),
            spec_dir_name: name.to_string(),
        };
        assert_eq!(migratable_spec_dir(&workspace("specseal"), "migration").unwrap(), "specseal");
        assert_eq!(migratable_spec_dir(&workspace("openspec"), "migration").unwrap(), "openspec");
        let error = migratable_spec_dir(&workspace("docs/specs"), "local-to-remote migration").unwrap_err();
        assert!(error.contains("default spec folder") && error.contains("docs/specs/"), "{error}");
    }

    #[test]
    fn both_default_folders_side_by_side_are_refused() {
        // 只备份 specseal/ 会留下 openspec/：转成 checkout 后一开就是本机与远程并存。
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("specseal/changes")).unwrap();
        std::fs::create_dir_all(root.path().join("openspec/changes")).unwrap();
        let workspace = specseal_core::workspace::Workspace {
            root: root.path().to_path_buf(),
            spec_dir_name: "specseal".to_string(),
        };
        let error = migratable_spec_dir(&workspace, "local-to-remote migration").unwrap_err();
        assert!(error.contains("move or remove openspec/ first"), "{error}");

        // 反方向：明写 spec_dir: openspec，旁边又有作为规格文件夹的 specseal/。
        let legacy = specseal_core::workspace::Workspace {
            root: root.path().to_path_buf(),
            spec_dir_name: "openspec".to_string(),
        };
        let error = migratable_spec_dir(&legacy, "local-to-remote migration").unwrap_err();
        assert!(error.contains("move or remove specseal/ first"), "{error}");
    }

    #[test]
    fn a_corrupt_legacy_archived_data_file_is_named_as_it_is_on_disk() {
        let root = complete_workspace();
        write(
            root.path(),
            "openspec/changes/archive/2026-07-20-old-change/.openspec.yaml",
            "schema: [unterminated\n",
        );
        let error = build_import_bundle(root.path(), "demo", "backend").expect_err("corrupt metadata must fail closed");
        assert!(
            error.contains("openspec/changes/archive/2026-07-20-old-change/.openspec.yaml"),
            "error names the file that is on disk: {error}"
        );
    }

    #[test]
    fn an_archived_change_with_both_data_files_uploads_only_the_new_one() {
        let root = complete_workspace();
        write(
            root.path(),
            "openspec/changes/archive/2026-07-20-old-change/.meta.yaml",
            "schema: spec-driven\ncreated: 2026-07-19\n",
        );
        let bundle = build_import_bundle(root.path(), "demo", "backend").expect("bundle builds");
        let metas: Vec<(String, String)> = bundle
            .documents
            .into_iter()
            .filter_map(|d| match d.document {
                ImportDocumentId::ArchivedChange { doc, .. } if doc.ends_with(".yaml") => Some((doc, d.content)),
                _ => None,
            })
            .collect();
        assert_eq!(metas, [(".meta.yaml".to_string(), "schema: spec-driven\ncreated: 2026-07-19\n".to_string())]);
    }

    #[test]
    fn adopting_server_truth_only_renames_local_truth_and_preserves_the_marker() {
        let root = complete_workspace();
        let marker = "remote:\n  url: https://spec.example.test/api/specseal/v1/projects/demo\n  repo: backend\n";
        write(root.path(), ".specseal.yaml", marker);

        let backup = adopt_remote_workspace_with(root.path(), "openspec", "2026-07-21", |from, to| {
            std::fs::rename(from, to)
        })
        .expect("server truth adoption succeeds");

        assert_eq!(backup, root.path().join("openspec.migrated-2026-07-21"));
        assert!(!root.path().join("openspec").exists());
        assert!(backup.join("changes/active-change/proposal.md").is_file());
        assert_eq!(
            std::fs::read_to_string(root.path().join(".specseal.yaml")).unwrap(),
            marker,
            "remote marker is not rewritten"
        );
    }

    #[test]
    fn a_rename_failure_keeps_local_truth_and_writes_no_marker() {
        let root = complete_workspace();
        let error = finalize_local_migration_with(
            root.path(),
            "openspec",
            "https://spec.example.test",
            "demo",
            "backend",
            "2026-07-21",
            |_, _| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "fixture denied",
                ))
            },
        )
        .expect_err("rename failure is reported");

        assert!(error.contains("server import succeeded"));
        assert!(error.contains("Rename") && error.contains("do not retry import"));
        assert!(root.path().join("openspec").is_dir());
        assert!(!root.path().join("openspec.migrated-2026-07-21").exists());
        assert!(!root.path().join(".specseal.yaml").exists());
    }
}

#[cfg(test)]
mod discussion_document_tests {
    use super::discussion_document_of;
    use specseal_protocol::query::ShowDiscussionResponse;
    use specseal_remote::RemoteError;

    const INFO: &str = r#"{"slug":"panel","topic":"Panel","status":"promoted","rounds":0,"created":"2026-11-01","promotedTo":["add-y"],"path":"discussions/panel.md","archived":false}"#;

    fn shown(cuts: &str) -> ShowDiscussionResponse {
        serde_json::from_str(&format!(r##"{{"info":{INFO},"content":"# Discussion\n"{cuts}}}"##)).unwrap()
    }

    #[test]
    fn discussion_document_carries_the_cuts_of_the_detail_response() {
        let wire = r#"[{"cut":"cut 3","title":"路线图","note":"","line":"**cut 3 `add-z`**: 路线图","changes":["add-z"],"changesInBold":true,"unpromoted":["add-z"]}]"#;
        let doc = discussion_document_of(Ok(shown(&format!(r#","cuts":{wire}"#)))).unwrap().expect("found");
        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(json["content"], "# Discussion\n");
        assert_eq!(json["cuts"], serde_json::from_str::<serde_json::Value>(wire).unwrap(), "cuts 逐栏同值");
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["content", "cuts"], "与本地的讨论记录回应同形");
    }

    #[test]
    fn discussion_document_from_an_old_server_has_empty_cuts() {
        let doc = discussion_document_of(Ok(shown(""))).unwrap().expect("found");
        assert_eq!(doc.content, "# Discussion\n");
        assert!(doc.cuts.is_empty());
    }

    #[test]
    fn discussion_document_not_found_is_none_and_other_errors_pass_through() {
        let error = |status| RemoteError { message: "boom".into(), reason: None, status, evidence: None };
        assert_eq!(discussion_document_of(Err(error(Some(404)))).unwrap(), None);
        assert_eq!(discussion_document_of(Err(error(Some(500)))).unwrap_err().message, "boom");
    }
}
