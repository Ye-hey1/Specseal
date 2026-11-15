//! specseal-protocol: the single Rust definition of the Specseal Client
//! Protocol wire contract (see `openspec/specs/client-protocol/spec.md`).
//!
//! Rust types are the canon; JSON Schema is an export (design decision two).
//! This crate holds types, constants, and the error reason registry only —
//! it must never depend on specseal-core, specseal-host, or specseal-store:
//! the wire contract is the shared downstream of both client and server, and
//! neither side's implementation details may leak in.

pub mod auth;
pub mod binding;
pub mod command;
pub mod context;
pub mod device;
pub mod drift;
pub mod error;
pub mod events;
pub mod query;
pub mod skills;

/// The contract major version this protocol speaks — sent as the
/// `X-Specseal-Api-Version` request header and declared back by the server
/// in the handshake's `apiVersion` field.
pub const API_VERSION: &str = "1";
