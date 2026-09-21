import { authenticateAccessUser } from "../auth/httpAuth.js";
import { normalizePortableName } from "../services/fsMutation.js";
import { type AppContext, mapError } from "./http.js";

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `tag_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function tagName(context: AppContext): Promise<{ name: string; nameCi: string }> {
  const body: { name?: unknown } = await context.req.json();
  if (typeof body.name !== "string") throw new RangeError("Tag name is required");
  return normalizePortableName(body.name);
}

export async function handleListTags(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const tags = await context.env.DB.prepare(
      "SELECT t.id,t.name,(SELECT COUNT(*) FROM node_tags nt JOIN nodes n ON n.id=nt.node_id WHERE nt.tag_id=t.id AND n.deleted_at IS NULL) nodeCount FROM tags t WHERE t.user_id=?1 ORDER BY t.name_ci,t.id LIMIT 1000",
    )
      .bind(user.principal.userId)
      .all<{ id: string; name: string; nodeCount: number }>();
    return context.json({ items: tags.results });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCreateTag(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const name = await tagName(context);
    const id = randomId();
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND revoked_at IS NULL AND expires_at>(strftime('%s','now')*1000))",
      ).bind(user.principal.sessionId, user.principal.userId),
      context.env.DB.prepare("INSERT INTO tags(id,user_id,name,name_ci) VALUES(?1,?2,?3,?4)").bind(
        id,
        user.principal.userId,
        name.name,
        name.nameCi,
      ),
      context.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return context.json({ id, name: name.name, nodeCount: 0 }, 201);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleUpdateTag(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const name = await tagName(context);
    await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE tags SET name=?1,name_ci=?2 WHERE id=?3 AND user_id=?4 AND EXISTS(SELECT 1 FROM sessions WHERE id=?5 AND user_id=?4 AND revoked_at IS NULL AND expires_at>(strftime('%s','now')*1000))",
      ).bind(
        name.name,
        name.nameCi,
        context.req.param("tagId"),
        user.principal.userId,
        user.principal.sessionId,
      ),
      context.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return context.json({ id: context.req.param("tagId"), name: name.name });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleDeleteTag(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const id = context.req.param("tagId");
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND revoked_at IS NULL AND expires_at>(strftime('%s','now')*1000))",
      ).bind(user.principal.sessionId, user.principal.userId),
      context.env.DB.prepare(
        "DELETE FROM node_tags WHERE tag_id IN (SELECT id FROM tags WHERE id=?1 AND user_id=?2)",
      ).bind(id, user.principal.userId),
      context.env.DB.prepare("DELETE FROM tags WHERE id=?1 AND user_id=?2").bind(
        id,
        user.principal.userId,
      ),
      context.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}
