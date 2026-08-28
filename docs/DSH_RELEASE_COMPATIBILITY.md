# DeepSeek Harness Release Compatibility

This page separates install compatibility from source-only contract evidence.
Neither form of evidence is an endorsement by DeepSeek.

## Evidence matrix

| Official Harness release | Availability | Plan Lattice artifact | Evidence scope |
| --- | --- | --- | --- |
| `dsh-v0.1.0-rc.7` (`99f6f02fec`) | npm `@deepseek-ai/dsh@0.1.0-rc.7` | Published `v0.4.0-rc.6` and current main candidate | Fresh-profile install, rendered profile membership, real Web HTTP 200 and title, and all 16 `lattice_*` schemas |
| `dsh-v0.1.1-rc.2` (`b150a551b8`) | npm `@deepseek-ai/dsh@0.1.1-rc.2`; current `latest` and `next` on 2026-08-28 | Published `v0.4.0-rc.6` and current main candidate | The same install, Web startup, and schema-registration checks |
| `dsh-v0.1.2-alpha.1` (`cd5ef81481`) | Source tag only on 2026-08-28; no npm package or GitHub Release asset | Published `v0.4.0-rc.6` and current main candidate | Source-contract proof only: the exact official alpha.1 inventory implementation observes the active Loader entry as `{ name: "dsh-plan-lattice", version: "..." }` |

The [Verify workflow](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml)
uploads `dsh-plugin-compatibility/v1` records for installable Harness releases
and a separate `dsh-plugin-inventory-source-contract/v1` record for alpha.1.

## Alpha.1 identity boundary

Alpha.1 adds the default-on
`@deepseek-ai/dsh-plugin-package-inventory-deepseek` package. For official
DeepSeek API requests it contributes a `dsh_plugin_packages` provider field
containing active Loader-backed package names and versions. The field is
outside model messages, system prompts, and tool schemas.

The source-contract test uses the exact official alpha.1 tag and implementation,
an ACTIVE `dsh-plan-lattice` Loader entry, and the exact package manifests from
the published RC.6 tarball and current candidate tarball. It does not send a
paid API request and does not claim full alpha.1 install or runtime compatibility,
because DeepSeek has not published an installable alpha.1 artifact.

Package inventory inclusion is runtime observability. It does not mean that
DeepSeek reviewed, approved, recommended, or endorsed Plan Lattice.
