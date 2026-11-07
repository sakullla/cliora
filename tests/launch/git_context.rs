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
    assert_eq!(main_checkout(&nested), Some(repo.clone()));
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
    assert_eq!(main_checkout(&checkout.join("src")), Some(main));
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
        assert_eq!(worktrees(&plain.join("missing")), None);
    }
    let broken = scratch("broken");
    write(&broken.join(".git/HEAD"), "not a ref");
    assert_eq!(read(&broken), None);
}

#[test]
fn worktrees_list_the_main_checkout_and_each_linked_worktree() {
    // Build the fixture with real git so the on-disk layout matches exactly what
    // production reads; skip gracefully when git is unavailable in the sandbox.
    let base = scratch("worktrees-list");
    let main = base.join("cliora");
    std::fs::create_dir_all(&main).unwrap();
    if git(&main, &["init", "-q", "-b", "main"]).is_none() {
        eprintln!("git unavailable; skipping worktrees enumeration test");
        return;
    }
    git(&main, &["config", "user.email", "t@example.com"]).unwrap();
    git(&main, &["config", "user.name", "Test"]).unwrap();
    git(&main, &["commit", "-q", "--allow-empty", "-m", "root"]).unwrap();
    // Two linked worktrees, each on its own branch, placed beside the main checkout.
    let hotfix_tree = base.join("cliora-hotfix");
    git(&main, &["worktree", "add", "-q", "-b", "hotfix/replay", hotfix_tree.to_str().unwrap()]).unwrap();
    let feature_tree = base.join("feature-sync");
    git(&main, &["worktree", "add", "-q", "-b", "feature/sync", feature_tree.to_str().unwrap()]).unwrap();

    // Reading from the main checkout: it is current, three checkouts in total.
    let from_main = worktrees(&main).expect("worktrees");
    assert_eq!(from_main.len(), 3, "got {from_main:?}");
    let main_entry = from_main.iter().find(|tree| tree.branch.as_deref() == Some("main")).expect("main listed");
    assert_eq!(main_entry.name, "cliora");
    assert!(main_entry.current);
    let hotfix = from_main.iter().find(|tree| tree.name == "cliora-hotfix").expect("hotfix listed");
    assert_eq!(hotfix.branch.as_deref(), Some("hotfix/replay"));
    assert!(!hotfix.current);
    assert!(from_main.iter().any(|tree| tree.name == "feature-sync" && tree.branch.as_deref() == Some("feature/sync")));

    // Reading from inside a linked worktree flags that checkout as current.
    let from_hotfix = worktrees(&hotfix_tree).expect("worktrees");
    assert_eq!(from_hotfix.len(), 3, "got {from_hotfix:?}");
    assert!(from_hotfix.iter().find(|tree| tree.name == "cliora-hotfix").expect("hotfix").current);
    assert!(!from_hotfix.iter().find(|tree| tree.name == "cliora").expect("main").current);
}

/// Run a git command in `cwd`; `None` when git is not installed.
fn git(cwd: &Path, args: &[&str]) -> Option<()> {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    status.success().then_some(())
}

#[test]
fn a_repository_without_linked_worktrees_lists_only_the_main_checkout() {
    let repo = scratch("single").join("shop");
    write(&repo.join(".git/HEAD"), "ref: refs/heads/main\n");
    let list = worktrees(&repo).expect("worktrees");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "shop");
    assert!(list[0].current);
}
