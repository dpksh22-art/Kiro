ALTER TABLE research_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'evidence_only'
  CHECK (status IN ('evidence_only','synthesized','failed_synthesis'));
ALTER TABLE research_reports ADD COLUMN selected_connection_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL;
ALTER TABLE research_reports ADD COLUMN selected_model_id TEXT REFERENCES models(id) ON DELETE SET NULL;
ALTER TABLE research_reports ADD COLUMN selected_provider TEXT;
ALTER TABLE research_reports ADD COLUMN selected_provider_model_id TEXT;
ALTER TABLE research_reports ADD COLUMN synthesis_json TEXT;
ALTER TABLE research_reports ADD COLUMN verification_json TEXT;
ALTER TABLE research_reports ADD COLUMN evidence_packet_json TEXT;
ALTER TABLE research_reports ADD COLUMN retrieval_errors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_reports ADD COLUMN synthesis_error TEXT;
ALTER TABLE research_reports ADD COLUMN provider_request_id TEXT;
ALTER TABLE research_reports ADD COLUMN synthesized_at TEXT;

ALTER TABLE usage_records ADD COLUMN research_report_id TEXT REFERENCES research_reports(id) ON DELETE SET NULL;
CREATE INDEX idx_usage_research_report ON usage_records(research_report_id, status);

CREATE TABLE research_report_sources (
  report_id TEXT NOT NULL REFERENCES research_reports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  citation_ordinal INTEGER NOT NULL CHECK (citation_ordinal > 0),
  included_in_synthesis INTEGER NOT NULL DEFAULT 0 CHECK (included_in_synthesis IN (0,1)),
  PRIMARY KEY(report_id, source_id),
  UNIQUE(report_id, citation_ordinal)
);
INSERT OR IGNORE INTO research_report_sources (report_id,source_id,citation_ordinal,included_in_synthesis)
SELECT r.id, json_extract(entry.value, '$.sourceId'), CAST(entry.key AS INTEGER), 0
FROM research_reports r, json_each(r.citation_map_json) AS entry
JOIN research_sources s ON s.id=json_extract(entry.value, '$.sourceId') AND s.user_id=r.user_id
WHERE json_valid(r.citation_map_json) AND CAST(entry.key AS INTEGER) > 0;
CREATE INDEX idx_research_report_sources_source ON research_report_sources(source_id, report_id);
