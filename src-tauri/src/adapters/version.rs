//! Tested releases are evidence, not exact version locks. Native responses are still validated.
#[derive(Clone, Debug)]
pub struct VersionPolicy {
    pub requirement: String,
    pub excluded: &'static [&'static str],
}
impl VersionPolicy {
    /// Opt into a native contract family. For 0.x this is an empirical adapter
    /// policy, not a claim that SemVer guarantees pre-1.0 compatibility.
    pub fn same_major(tested: &str) -> Self {
        let version = semver::Version::parse(tested).expect("adapter has a valid tested version");
        Self {
            requirement: format!(">={}.0.0, <{}.0.0", version.major, version.major + 1),
            excluded: &[],
        }
    }
    pub fn accepts(&self, installed: &str) -> bool {
        let Ok(version) = semver::Version::parse(installed.trim().trim_start_matches('v')) else {
            return false;
        };
        !self.excluded.iter().any(|excluded| {
            semver::Version::parse(excluded).is_ok_and(|excluded| {
                excluded.major == version.major
                    && excluded.minor == version.minor
                    && excluded.patch == version.patch
                    && excluded.pre == version.pre
            })
        }) && semver::VersionReq::parse(&self.requirement).is_ok_and(|r| r.matches(&version))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tested_patch_does_not_lock_patch_or_minor_releases() {
        for tested in ["2.1.287", "0.160.0", "0.99.2", "1.18.34", "1.0.46"] {
            let v = semver::Version::parse(tested).unwrap();
            let policy = VersionPolicy::same_major(tested);
            for candidate in [
                tested.to_owned(),
                format!("{}.{}.{}", v.major, v.minor, v.patch + 1),
                format!("{}.{}.0", v.major, v.minor + 1),
                format!("v{tested}"),
                format!("{tested}+build.1"),
            ] {
                assert!(policy.accepts(&candidate), "{tested}: {candidate}");
            }
            assert!(!policy.accepts(&format!("{}.0.0", v.major + 1)));
            assert!(!policy.accepts(&format!("{tested}-beta.1")));
        }
    }
    #[test]
    fn explicit_breakage_and_malformed_versions_remain_blocked() {
        let p = VersionPolicy {
            requirement: ">=2.0.0, <3.0.0".into(),
            excluded: &["2.2.0"],
        };
        assert!(!p.accepts("2.2.0"));
        assert!(!p.accepts("v2.2.0"));
        assert!(!p.accepts("2.2.0+build.1"));
        assert!(!p.accepts("2.2"));
        assert!(!p.accepts("unknown"));
        assert!(p.accepts("2.2.1"));
    }
}
