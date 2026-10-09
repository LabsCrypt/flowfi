# Database backup and disaster recovery

FlowFi stores encrypted PostgreSQL backups in Amazon S3. The backup includes a plain SQL dump and an exact row-count manifest for every table in the `public` schema. The combined archive is gzip-compressed and encrypted with AES-256-GCM before it is uploaded. A random 96-bit nonce and authentication tag are stored in the versioned `FFIENC01` envelope; authentication is verified before the restore script executes any SQL.

## Configure backup access

1. Create a private S3 bucket with versioning and public access blocked. Configure a bucket lifecycle rule that expires objects tagged `flowfi-backup-retention=30d` after 30 days. The upload script adds this tag to every object. Add this rule through your infrastructure-as-code or merge it with the bucket's existing lifecycle configuration; replacing a bucket's lifecycle configuration removes its other rules.
2. Configure the GitHub OIDC role referenced by both workflows with `s3:PutObject` and `s3:PutObjectTagging` for backups, `s3:ListBucket` for the configured prefix, and `s3:GetObject` for recovery. Prefer OIDC role assumption over static AWS access keys.
3. Generate a dedicated encryption key with `openssl rand -hex 32`. Store it in the production backup runner's secret store as `BACKUP_ENCRYPTION_KEY` and as a GitHub Actions secret with the same name. Keep a separately controlled offline copy. Losing this key makes the backups unrecoverable; never commit it or print it in logs.
4. Set `BACKUP_S3_URI` to `s3://bucket/prefix`. The backup workflow also needs the `PRODUCTION_DATABASE_URL` GitHub secret, PostgreSQL client tools (`pg_dump`, `psql`), Node.js, gzip, tar, and AWS CLI v2.
5. Configure the daily backup workflow with `PRODUCTION_DATABASE_URL`, the encryption key, bucket URI, and OIDC role settings. The workflow runs daily at 05:00 UTC and can also be started manually. Ensure the runner can reach the production database; use a self-hosted runner when the database is private. Check that a new object appears after each run and alert on failures.
6. In repository Actions settings, configure `BACKUP_AWS_ROLE_ARN` as a secret and `BACKUP_AWS_REGION` and `BACKUP_S3_URI` as repository or environment variables. The role must trust the repository's GitHub OIDC identity and allow the S3 actions listed above.

## Restore a backup

Restore to an empty PostgreSQL database. The script authenticates and decompresses the full archive before submitting SQL, then compares the restored count of every recorded public table to the manifest. It exits nonzero on decryption, archive, SQL, or row-count errors.

```sh
export DATABASE_URL='postgresql://user:password@localhost:5432/flowfi_recovery'
export BACKUP_ENCRYPTION_KEY='<64 hex characters from the secret store>'
bash scripts/db-restore.sh /secure/path/flowfi-<timestamp>-<run-id>.tar.gz.enc
```

For S3, download the selected object to a protected temporary location with `aws s3 cp`, then pass its path to the restore script. Restrict access to both the encrypted object and the key; encryption does not replace access controls.

## Weekly disaster-recovery verification

`.github/workflows/dr-test.yml` runs every Monday at 06:00 UTC and can also be started with **Actions Ã¢â€ â€™ Weekly disaster recovery verification Ã¢â€ â€™ Run workflow**. It starts an isolated, empty PostgreSQL 16 service, downloads the latest backup, decrypts and restores it, compares all public table counts, validates the Prisma schema, and checks migration status. A missing backup, invalid key/tag, restore error, count mismatch, or Prisma failure makes the workflow fail.

Review the workflow run after each scheduled execution. A successful restore drill demonstrates that the current backup and recovery credentials work; production recovery should still follow the same steps against a separately provisioned database and an authorized operator.