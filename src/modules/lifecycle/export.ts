import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { purgeExpiredMemories } from "@/src/modules/workspace/memory";

const encoder = new TextEncoder();

type ExportSection = { name: string; sql: string };

const sections: ExportSection[] = [
  { name: "projects", sql: `SELECT id,name,description,instructions,created_at AS createdAt,updated_at AS updatedAt FROM projects WHERE user_id=? ORDER BY created_at` },
  { name: "conversations", sql: `SELECT id,project_id AS projectId,title,mode,parent_conversation_id AS parentConversationId,created_at AS createdAt,updated_at AS updatedAt FROM conversations WHERE user_id=? ORDER BY created_at` },
  { name: "messages", sql: `SELECT m.id,m.conversation_id AS conversationId,m.parent_message_id AS parentMessageId,m.role,m.provider_model_id AS providerModelId,m.status,m.content,m.error_code AS errorCode,m.error_message AS errorMessage,m.input_tokens AS inputTokens,m.output_tokens AS outputTokens,m.estimated_cost_micros AS estimatedCostMicros,m.billed_cost_micros AS billedCostMicros,m.provider_request_id AS providerRequestId,m.created_at AS createdAt,m.completed_at AS completedAt FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? ORDER BY m.created_at` },
  { name: "agents", sql: `SELECT id,slug,name,role,instructions,routing_policy_json AS routingPolicyJson,allowed_tools_json AS allowedToolsJson,permission_policy_json AS permissionPolicyJson,budget_json AS budgetJson,max_duration_seconds AS maxDurationSeconds,max_turns AS maxTurns,memory_scope AS memoryScope,output_schema_json AS outputSchemaJson,completion_criteria AS completionCriteria,is_template AS isTemplate,created_at AS createdAt,updated_at AS updatedAt FROM agents WHERE user_id=? ORDER BY created_at` },
  { name: "runs", sql: `SELECT id,project_id AS projectId,conversation_id AS conversationId,title,goal,mode,status,max_parallelism AS maxParallelism,max_tasks AS maxTasks,max_depth AS maxDepth,deadline_at AS deadlineAt,cancel_requested_at AS cancelRequestedAt,created_at AS createdAt,updated_at AS updatedAt,completed_at AS completedAt FROM task_runs WHERE user_id=? ORDER BY created_at` },
  { name: "events", sql: `SELECT e.sequence,e.id,e.run_id AS runId,e.task_id AS taskId,e.event_type AS eventType,e.actor_type AS actorType,e.actor_id AS actorId,e.correlation_id AS correlationId,e.causation_id AS causationId,e.payload_json AS payloadJson,e.created_at AS createdAt FROM task_events e JOIN task_runs r ON r.id=e.run_id WHERE r.user_id=? ORDER BY e.sequence` },
  { name: "researchSources", sql: `SELECT id,run_id AS runId,connector,source_type AS sourceType,title,canonical_url AS canonicalUrl,published_at AS publishedAt,retrieved_at AS retrievedAt,content_hash AS contentHash,excerpt,metadata_json AS metadataJson,trust_level AS trustLevel FROM research_sources WHERE user_id=? ORDER BY retrieved_at` },
  { name: "researchReports", sql: `SELECT id,run_id AS runId,title,body,citation_map_json AS citationMapJson,created_at AS createdAt FROM research_reports WHERE user_id=? ORDER BY created_at` },
  { name: "memory", sql: `SELECT id,project_id AS projectId,kind,content,trust_level AS trustLevel,provenance,retention_policy AS retentionPolicy,expires_at AS expiresAt,created_at AS createdAt,updated_at AS updatedAt FROM project_memories WHERE user_id=? ORDER BY created_at` },
  { name: "artifacts", sql: `SELECT id,project_id AS projectId,run_id AS runId,name,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,provenance_json AS provenanceJson,upload_state AS uploadState,scan_status AS scanStatus,scanner_name AS scannerName,retention_expires_at AS retentionExpiresAt,created_at AS createdAt,updated_at AS updatedAt FROM artifacts WHERE user_id=? ORDER BY created_at` },
];

function* exportChunks(userId: string): Generator<Uint8Array> {
  yield encoder.encode(`{"schemaVersion":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"data":{`);
  let firstSection = true;
  for (const section of sections) {
    yield encoder.encode(`${firstSection ? "" : ","}${JSON.stringify(section.name)}:[`);
    firstSection = false;
    let firstRow = true;
    for (const row of getDb().prepare(section.sql).iterate(userId)) {
      yield encoder.encode(`${firstRow ? "" : ","}${JSON.stringify(row)}`);
      firstRow = false;
    }
    yield encoder.encode("]");
  }
  yield encoder.encode("}}");
}

export function createOwnerExport(userId: string): ReadableStream<Uint8Array> {
  purgeExpiredMemories(userId);
  writeAudit({ userId, action: "data.exported", resourceType: "account_data", outcome: "success", metadata: { schemaVersion: 1 } });
  const chunks = exportChunks(userId);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const next = chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
