-- Conservatively allocate one 64-byte system object even when a PUT acknowledgement is lost.
-- It is never deleted by ordinary cleanup: a late initial If-None-Match write must stay fenced.
CREATE TABLE r2_binding_probe(
 singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
 r2_key TEXT NOT NULL DEFAULT 'system/r2-binding-probe-v1' CHECK(r2_key='system/r2-binding-probe-v1'),
 allocated_bytes INTEGER NOT NULL DEFAULT 64 CHECK(allocated_bytes=64),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 source TEXT NOT NULL CHECK(json_valid(source) AND length(source)<=512),
 nonce TEXT NOT NULL CHECK(length(nonce)=64 AND nonce NOT GLOB '*[^a-f0-9]*'),
 phase TEXT NOT NULL CHECK(phase IN ('claimed','prepared','written','verified','idle','failed')),
 expected_etag TEXT CHECK(expected_etag IS NULL OR length(expected_etag) BETWEEN 1 AND 256),
 r2_etag TEXT CHECK(r2_etag IS NULL OR length(r2_etag) BETWEEN 1 AND 256),
 r2_version TEXT CHECK(r2_version IS NULL OR length(r2_version) BETWEEN 1 AND 256),
 uploaded_at INTEGER CHECK(uploaded_at IS NULL OR uploaded_at>=0),
 verified_at INTEGER CHECK(verified_at IS NULL OR verified_at>=0),
 lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token)=36),
 lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at>=0),
 calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 9007199254740991),
 last_error TEXT CHECK(last_error IS NULL OR length(last_error)<=64),
 CHECK((r2_etag IS NULL)=(r2_version IS NULL) AND (r2_etag IS NULL)=(uploaded_at IS NULL)),
 CHECK((phase='idle')=(lease_token IS NULL) AND (phase='idle')=(lease_expires_at=0)),
 CHECK(phase NOT IN ('claimed','prepared') OR (r2_etag IS NULL AND verified_at IS NULL)),
 CHECK(phase NOT IN ('written','verified','idle') OR r2_etag IS NOT NULL),
 CHECK(phase NOT IN ('verified','idle') OR verified_at IS NOT NULL),
 CHECK(phase<>'claimed' OR expected_etag IS NULL)
) STRICT;

CREATE TRIGGER r2_binding_probe_insert BEFORE INSERT ON r2_binding_probe
WHEN NEW.phase<>'claimed' OR NEW.generation<>1 OR NEW.calls<>0
BEGIN SELECT RAISE(ABORT,'invalid_r2_binding_probe_claim'); END;
CREATE TRIGGER r2_binding_probe_update BEFORE UPDATE ON r2_binding_probe
WHEN NEW.singleton<>OLD.singleton OR NEW.r2_key<>OLD.r2_key OR NEW.allocated_bytes<>OLD.allocated_bytes
 OR NEW.epoch<OLD.epoch OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 OR NEW.calls<OLD.calls
 OR (NEW.generation<>OLD.generation AND (NEW.phase<>'claimed' OR NEW.nonce=OLD.nonce
   OR NEW.lease_token IS OLD.lease_token OR OLD.lease_expires_at>strftime('%s','now')*1000))
 OR (NEW.generation=OLD.generation AND (
   NEW.epoch<>OLD.epoch OR NEW.source<>OLD.source OR NEW.nonce<>OLD.nonce
   OR (NOT (OLD.phase='claimed' AND NEW.phase='prepared') AND NEW.expected_etag IS NOT OLD.expected_etag)
   OR (NOT (OLD.phase='prepared' AND NEW.phase='written') AND
     (NEW.r2_etag IS NOT OLD.r2_etag OR NEW.r2_version IS NOT OLD.r2_version OR NEW.uploaded_at IS NOT OLD.uploaded_at))
   OR (NOT (OLD.phase='written' AND NEW.phase='verified') AND NEW.verified_at IS NOT OLD.verified_at)
   OR (NOT (OLD.phase='verified' AND NEW.phase='idle') AND
     (NEW.lease_token IS NOT OLD.lease_token OR NEW.lease_expires_at>OLD.lease_expires_at))
   OR NOT (NEW.phase=OLD.phase OR (NEW.phase='failed' AND OLD.phase<>'idle')
     OR (OLD.phase='claimed' AND NEW.phase='prepared') OR (OLD.phase='prepared' AND NEW.phase='written')
     OR (OLD.phase='written' AND NEW.phase='verified') OR (OLD.phase='verified' AND NEW.phase='idle'))))
BEGIN SELECT RAISE(ABORT,'immutable_r2_binding_probe'); END;
CREATE TRIGGER r2_binding_probe_delete BEFORE DELETE ON r2_binding_probe
BEGIN SELECT RAISE(ABORT,'r2_binding_probe_allocation_required'); END;

-- Reserve the key before first use, including for restored legacy catalogues.
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT 1 FROM blobs WHERE r2_key='system/r2-binding-probe-v1')
 OR EXISTS(SELECT 1 FROM derivative_results WHERE r2_key='system/r2-binding-probe-v1')
 OR EXISTS(SELECT 1 FROM archive_index WHERE r2_key='system/r2-binding-probe-v1')
 OR EXISTS(SELECT 1 FROM target_sets WHERE manifest_ref='system/r2-binding-probe-v1');
CREATE TRIGGER blobs_binding_key_insert BEFORE INSERT ON blobs
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER blobs_binding_key_update BEFORE UPDATE OF r2_key ON blobs
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER derivatives_binding_key_insert BEFORE INSERT ON derivative_results
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER derivatives_binding_key_update BEFORE UPDATE OF r2_key ON derivative_results
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER archive_binding_key_insert BEFORE INSERT ON archive_index
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER archive_binding_key_update BEFORE UPDATE OF r2_key ON archive_index
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER target_sets_binding_key_insert BEFORE INSERT ON target_sets
WHEN NEW.manifest_ref='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER target_sets_binding_key_update BEFORE UPDATE OF manifest_ref ON target_sets
WHEN NEW.manifest_ref='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
