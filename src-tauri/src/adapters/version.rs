//! Tested releases are evidence, not exact version locks. Native responses are still validated.

/// Accepted native contract families. A release is accepted when it is not
/// explicitly excluded and at least one verified family matches, so several
/// verified major lines can coexist without pinning patch/minor releases.
#[derive(Clone, Debug)]
pub struct VersionPolicy {
    pub requirements: Vec<String>,
    pub excluded: &'static [&'static str],
}
impl VersionPolicy {
    /// Opt into a native contract family. For 0.x this is an empirical adapter
    /// policy, not a claim that SemVer guarantees pre-1.0 compatibility.
    pub fn same_major(tested: &str) -> Self {
        Self::same_majors(&[tested])
    }
    /// Opt into several independently verified major contract families. Each
    /// tested release only pins its own major line, so patch/minor updates on
    /// any accepted line stay accepted.
    pub fn same_majors(tested: &[&str]) -> Self {
        Self {
            requirements: tested
                .iter()
                .map(|tested| {
                    let version =
                        semver::Version::parse(tested).expect("adapter has a valid tested version");
                    format!(">={}.0.0, <{}.0.0", version.major, version.major + 1)
                })
                .collect(),
            excluded: &[],
        }
    }
    /// User-facing union of the accepted intervals, e.g.
    /// `">=1.0.0, <2.0.0 或 >=2.0.0, <3.0.0"`.
    pub fn accepted_text(&self) -> String {
        self.requirements.join(" 或 ")
    }
    pub fn accepts(&self, installed: &str) -> bool {
        let Ok(version) = semver::Version::parse(installed.trim().trim_start_matches('v')) else {
            return false;
        };
        if self.excluded.iter().any(|excluded| {
            semver::Version::parse(excluded).is_ok_and(|excluded| {
                excluded.major == version.major
                    && excluded.minor == version.minor
                    && excluded.patch == version.patch
                    && excluded.pre == version.pre
            })
        }) {
            return false;
        }
        self.requirements.iter().any(|requirement| {
            semver::VersionReq::parse(requirement)
                .is_ok_and(|requirement| requirement.matches(&version))
        })
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
    fn several_verified_major_families_are_accepted_together() {
        let policy = VersionPolicy::same_majors(&["1.18.34", "2.0.29"]);
        for candidate in [
            "1.0.0",
            "1.18.34",
            "1.19.0",
            "1.99.99",
            "2.0.0",
            "2.0.29",
            "2.5.0",
            "v2.5.0",
            "2.0.29+build.7",
        ] {
            assert!(policy.accepts(candidate), "{candidate}");
        }
        for candidate in ["0.99.9", "3.0.0", "2.0.29-beta.1", "unknown", "2.0"] {
            assert!(!policy.accepts(candidate), "{candidate}");
        }
        assert_eq!(
            policy.accepted_text(),
            ">=1.0.0, <2.0.0 或 >=2.0.0, <3.0.0"
        );
    }
    #[test]
    fn explicit_breakage_and_malformed_versions_remain_blocked() {
        let p = VersionPolicy {
            requirements: vec![">=2.0.0, <3.0.0".into()],
            excluded: &["2.2.0"],
        };
        assert!(!p.accepts("2.2.0"));
        assert!(!p.accepts("v2.2.0"));
        assert!(!p.accepts("2.2.0+build.1"));
        assert!(!p.accepts("2.2"));
        assert!(!p.accepts("unknown"));
        assert!(p.accepts("2.2.1"));
        let multi = VersionPolicy {
            requirements: VersionPolicy::same_majors(&["1.18.34", "2.0.29"]).requirements,
            excluded: &["2.0.29"],
        };
        assert!(!multi.accepts("2.0.29"));
        assert!(multi.accepts("1.19.0"));
        assert!(multi.accepts("2.0.30"));
    }
}
