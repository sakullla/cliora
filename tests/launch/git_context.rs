use super::*;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("cliora-git-context-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("scratch directory");
    root
}

fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("parent directory");
    std::fs::write(path, content).expect("file written");
}

#[test]
fn branch_is_read_from_a_nested_directory() {
    let repo = scratch("branch").join("shop");
    write(&repo.join(".git/HEAD"), "ref: refs/heads/feature/checkout\n");
    let nested = repo.join("src/orders");
    std::fs::create_dir_all(&nested).unwrap();
    let context = read(&nested).expect("context");
    assert_eq!(context.branch.as_deref(), Some("feature/checkout"));
    assert_eq!(context.commit, None);
    assert_eq!(context.worktree, None);
    assert_eq!(context.repository.as_deref(), Some("shop"));
}

#[test]
fn detached_head_reports_a_short_commit() {
    let repo = scratch("detached").join("api");
    write(&repo.join(".git/HEAD"), "3F2A9C1D0E4B5A6978FFEEDDCCBBAA0099887766\n");
    let context = read(&repo).expect("context");
    assert_eq!(context.branch, None);
    assert_eq!(context.commit.as_deref(), Some("3f2a9c1"));
}

#[test]
fn linked_worktree_names_the_worktree_and_the_main_checkout() {
    let base = scratch("worktree");
    let main = base.join("cliora");
    write(&main.join(".git/HEAD"), "ref: refs/heads/main\n");
    let admin = main.join(".git/worktrees/cliora-hotfix");
    write(&admin.join("HEAD"), "ref: refs/heads/hotfix/replay\n");
    write(&admin.join("commondir"), "../..\n");
    let checkout = base.join("cliora-hotfix");
    write(&checkout.join(".git"), &format!("gitdir: {}\n", admin.display()));
    let context = read(&checkout.join("src")).expect("context");
    assert_eq!(context.branch.as_deref(), Some("hotfix/replay"));
    assert_eq!(context.worktree.as_deref(), Some("cliora-hotfix"));
    assert_eq!(context.repository.as_deref(), Some("cliora"));
}

#[test]
fn submodule_pointer_is_not_a_worktree() {
    let base = scratch("submodule");
    let admin = base.join("app/.git/modules/vendor-lib");
    write(&admin.join("HEAD"), "ref: refs/heads/main\n");
    let module = base.join("app/vendor-lib");
    write(&module.join(".git"), "gitdir: ../.git/modules/vendor-lib\n");
    let context = read(&module).expect("context");
    assert_eq!(context.branch.as_deref(), Some("main"));
    assert_eq!(context.worktree, None);
    assert_eq!(context.repository.as_deref(), Some("vendor-lib"));
}

#[test]
fn directories_outside_a_repository_have_no_context() {
    let plain = scratch("plain");
    // A machine whose temp directory sits inside a checkout cannot show "outside".
    if !plain.ancestors().any(|path| path.join(".git").exists()) {
        assert_eq!(read(&plain.join("missing")), None);
    }
    let broken = scratch("broken");
    write(&broken.join(".git/HEAD"), "not a ref");
    assert_eq!(read(&broken), None);
}
