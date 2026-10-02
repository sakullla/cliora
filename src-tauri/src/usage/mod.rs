//! Remote quota queries are independent of local history token estimates.
mod contract;
mod store;

pub use contract::*;
pub use store::{delete_query, get_query, list_queries, save_query};

#[cfg(test)]
#[path = "../../../tests/usage/queries.rs"]
mod tests;
