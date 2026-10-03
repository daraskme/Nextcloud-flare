# User backup automation installer

`install-user-automation.mjs` prepares an internal, private release and two user timers. It does not run a backup. `--check` is read-only; `--install` is the explicit installation action. Run it only from a committed checkout. The installer refuses modified or untracked runtime source, existing destinations, symlinked private inputs and temporary release roots.

Supply every option below with an absolute path or the provisioned public identifier. The credential source must be owned by the user, mode `0600`, and contain exactly these unquoted lines: `CLOUDFLARE_API_TOKEN`, `R2_INVENTORY_ACCESS_KEY_ID`, `R2_INVENTORY_SECRET_ACCESS_KEY`. The admin public-key JSON and monitor JSON must also be owned `0600` regular files. Never pass the recovery JSON to this service.

```sh
node ops/backup/install-user-automation.mjs --check \
  --root /home/USER/.local/share/ncf-automation \
  --repo /home/USER/Nextcloud-flare \
  --systemd-dir /home/USER/.config/systemd/user \
  --credentials /home/USER/private/cloudflare.env \
  --public-key /home/USER/private/admin-public.json \
  --monitor-config /home/USER/private/monitor.json \
  --node /persistent/path/node \
  --pnpm /persistent/path/pnpm \
  --workerd /persistent/path/workerd \
  --external-root /mounted/volume/Nextcloudflare-backups \
  --mount-point /mounted/volume \
  --volume-uuid REPLACE_WITH_VOLUME_UUID \
  --cloudflare-account REPLACE_WITH_ACCOUNT_HEX32 \
  --database REPLACE_WITH_STAGING_D1_UUID \
  --admin-account REPLACE_WITH_ADMIN_ACCOUNT_ID
```

The default full-blob audit cap is 10,000 objects and 10 GiB. Set `--max-objects` and `--max-bytes` only after reviewing the current inventory; both values have hard upper bounds. These limits fail closed before copying beyond the configured amount.

After reviewing the check result, change only `--check` to `--install`. Installation copies a fixed git-tracked source allowlist and verified local dependency tree into the internal release. It also copies Node, pnpm, workerd and the OS tools required by the services into the internal toolchain, so the services do not use `/tmp` or `/run` for their code and binaries. Temporary files use the internal `TMPDIR`. On NixOS, copied executables can still reference their dynamic libraries in `/nix/store`; keep the system closure available and recheck after an OS or toolchain upgrade. The external volume receives only the encrypted `.ncf` archive through the backup runner.

The backup timer runs Sunday 03:30 in `Asia/Tokyo`; the monitor runs hourly. Both timers use `Persistent=true`. Backup and monitor each have a `flock` lock. A failed backup service retries after 30 minutes, including when a volume was absent just after login. The runner resumes the same unfinished generation and deduplicates a completed week; retries do not cancel or thaw a frozen backup. Existing unit files or release roots are never overwritten. The installer enables the timers with `systemctl --user`; if a user session is not running continuously, configure user lingering separately with the operating system administrator so the timer can fire while logged out. A missing external mount is recorded as a weekly backup failure in the private internal state and reported by the monitor.

Review `systemctl --user status ncf-weekly-backup.timer ncf-backup-monitor.timer` after installation. A service dry run can use the installed Node and runtime environment through the generated unit, but the first actual backup is a remote operation and should follow the operator runbook.
