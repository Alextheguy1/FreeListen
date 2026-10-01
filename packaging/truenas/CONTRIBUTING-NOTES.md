# TrueNAS catalog app definition

These are the files that define FreeListen as an app in the
[TrueNAS apps catalog](https://github.com/truenas/apps). They live here so
they're versioned alongside the app they describe - when FreeListen changes
in a way that affects deployment, this needs updating too.

## How it gets submitted

The catalog expects them at `ix-dev/community/freelisten/` in a fork of
`truenas/apps`, plus a `templates/library/base_<version>/` directory that
their tooling vendors in (don't write that by hand - copy it from an existing
app at the same `lib_version`).

```
ix-dev/community/freelisten/
├── app.yaml                      # metadata, version, maintainers
├── item.yaml                     # catalog listing (icon, categories)
├── ix_values.yaml                # image pin + constant paths
├── questions.yaml                # the config form shown in the TrueNAS UI
├── README.md                     # description shown in the catalog
└── templates/
    ├── docker-compose.yaml       # Jinja2, renders via their library
    ├── library/base_2_3_4/       # vendored by their tooling, not authored
    └── test_values/
        └── basic-values.yaml     # values their CI deploys with
```

Then `./.github/scripts/ci.py --app freelisten --train community --test-file basic-values.yaml`
(needs Docker), and open a PR against `truenas/apps`.

## Things that are easy to get wrong

- **The image must be pinned by digest**, not a floating tag. Update
  `ix_values.yaml` whenever a new version is released, and keep
  `app_version` in `app.yaml` in step with it.
- **The default port must be unique across every app in the catalog.** Theirs
  is checked by `.github/scripts/port_validation.py`. FreeListen uses 30504 (30102 was taken by stable/diskoverdata);
  if that gets taken before the PR merges, pick another free one and re-run
  that script.
- **The container runs as uid 568**, not root. Anything in the image that
  needs to write must be either a mounted volume or somewhere world-writable
  - that's why `HOME=/tmp` is set in the Dockerfile.
- **The healthcheck calls `curl`**, which is why the image installs it even
  though the app never uses it.
- **Icons and screenshots are hosted on their CDN** and uploaded by reviewers,
  so the URLs in `app.yaml`/`item.yaml` only resolve after the PR is merged.
  `assets/icon.svg` in this repo is the source image to give them.
- **`maintainers` is TrueNAS**, not the contributor - that's their convention
  for community apps, since they take on maintenance once it's merged.
