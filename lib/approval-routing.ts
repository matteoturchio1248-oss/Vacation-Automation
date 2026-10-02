import { database } from "./database";
import type { ApprovalGraph, ApprovalMapDocument } from "./approval-map-types";

// Unique source indexes guarantee one joined route, never one row per branch.
// A person box overrides department membership, including when unconnected.
export function approvalRouteJoins(employee: string, department: string, prefix = "routing") {
  const person = `${prefix}_person`, team = `${prefix}_team`, target = `${prefix}_target`, approver = `${prefix}_approver`;
  const kind = `CASE WHEN ${person}.id IS NOT NULL THEN ${person}.target_kind WHEN ${team}.id IS NOT NULL THEN ${team}.target_kind ELSE 'person' END`;
  const id = `CASE WHEN ${person}.id IS NOT NULL THEN ${person}.target_id WHEN ${team}.id IS NOT NULL THEN ${team}.target_id ELSE (SELECT manager_user_id FROM departments WHERE id = ${department}) END`;
  return `LEFT JOIN approval_routes ${person} ON ${person}.map_id = 'vacation' AND ${person}.source_kind = 'person' AND ${person}.source_id = ${employee}
    LEFT JOIN approval_routes ${team} ON ${team}.map_id = 'vacation' AND ${team}.source_kind = 'department' AND ${team}.source_id = ${department}
    LEFT JOIN departments ${target} ON (${kind}) = 'department' AND ${target}.id = (${id})
    LEFT JOIN users ${approver} ON ${approver}.id = CASE WHEN (${kind}) = 'department' THEN ${target}.manager_user_id ELSE (${id}) END
      AND ${approver}.id != ${employee} AND ${approver}.role IN ('manager', 'admin')
      AND ${approver}.status IN ('active', 'on_leave') AND ${approver}.has_portal_access = 1`;
}

export async function resolveApproval(employeeId: number, departmentId: number) {
  return database().prepare(`SELECT routing_approver.id AS approver_id, routing_approver.email AS approver_email,
    routing_approver.full_name AS approver_name FROM users e LEFT JOIN departments d ON d.id = ?
    ${approvalRouteJoins("e.id", "d.id", "routing")} WHERE e.id = ?`)
    .bind(departmentId, employeeId)
    .first<{ approver_id: number | null; approver_email: string | null; approver_name: string | null }>();
}

type Person = { id: number; role: string; status: string; has_portal_access: number };
type Team = { id: number; manager_user_id: number | null };
function eligible(person: Person | undefined) { return Boolean(person && ["manager", "admin"].includes(person.role) && ["active", "on_leave"].includes(person.status) && person.has_portal_access); }

export async function loadApprovalMap(teams: Team[], people: Person[]): Promise<ApprovalMapDocument> {
  const saved = await database().prepare("SELECT revision, graph_json, updated_at FROM approval_maps WHERE id = 'vacation'").first<{ revision: number; graph_json: string; updated_at: string }>();
  if (saved) return { revision: saved.revision, graph: JSON.parse(saved.graph_json), updatedAt: saved.updated_at };
  const managerIds = [...new Set(teams.map((team) => team.manager_user_id).filter((id): id is number => id != null && eligible(people.find((person) => person.id === id))))];
  return { revision: 0, updatedAt: null, graph: {
    nodes: [...teams.map((team, index) => ({ id: `department:${team.id}`, kind: "department" as const, entityId: team.id, x: 40, y: 40 + index * 190 })),
      ...managerIds.map((id, index) => ({ id: `person:${id}`, kind: "person" as const, entityId: id, x: 430, y: 40 + index * 190 }))],
    edges: teams.filter((team) => team.manager_user_id != null && managerIds.includes(team.manager_user_id)).map((team) => ({ from: `department:${team.id}`, to: `person:${team.manager_user_id}` })),
  } };
}

export async function saveApprovalMap(input: unknown, expectedRevision: unknown, updatedBy: number) {
  const graph = input as ApprovalGraph;
  const revision = Number(expectedRevision);
  if (!Number.isInteger(revision) || revision < 0 || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 500 || graph.edges.length > 500) throw new Error("Choose a valid approval map with up to 500 boxes.");
  const [peopleRows, teamRows] = await Promise.all([
    database().prepare("SELECT id, role, status, has_portal_access FROM users").all<Person>(),
    database().prepare("SELECT id, manager_user_id FROM departments").all<Team>(),
  ]);
  const people = new Map(peopleRows.results.map((person) => [person.id, person]));
  const teams = new Map(teamRows.results.map((team) => [team.id, team]));
  const nodes = new Map<string, ApprovalGraph["nodes"][number]>();
  for (const node of graph.nodes) {
    if (!node || !["department", "person"].includes(node.kind) || !Number.isInteger(node.entityId) || node.id !== `${node.kind}:${node.entityId}` || nodes.has(node.id)) throw new Error("Each employee or department may appear in only one box.");
    if (node.kind === "person" ? !people.has(node.entityId) : !teams.has(node.entityId)) throw new Error("A box refers to an employee or department that no longer exists.");
    if (![node.x, node.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 100000)) throw new Error("Keep boxes within the approval canvas.");
    nodes.set(node.id, { id: node.id, kind: node.kind, entityId: node.entityId, x: Math.round(node.x), y: Math.round(node.y) });
  }
  const links = new Map<string, string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge?.from), to = nodes.get(edge?.to);
    if (!from || !to || from.id === to.id || links.has(from.id)) throw new Error("Each box needs one approver at most; duplicate lines and self-connections are not allowed.");
    const target = to.kind === "person" ? people.get(to.entityId) : people.get(teams.get(to.entityId)?.manager_user_id ?? -1);
    if (!eligible(target)) throw new Error("Connect to an active Manager or Administrator with portal access, or a department with that manager assigned.");
    if (from.kind === "person" && target?.id === from.entityId) throw new Error("Employees cannot approve their own vacation.");
    links.set(from.id, to.id);
  }
  for (const node of nodes.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = node;
    while (current) { if (seen.has(current)) throw new Error("Approval lines cannot form a circular chain."); seen.add(current); current = links.get(current); }
  }
  const clean: ApprovalGraph = { nodes: [...nodes.values()], edges: [...links].map(([from, to]) => ({ from, to })) };
  const routes = clean.nodes.map((node) => { const target = nodes.get(links.get(node.id) ?? ""); return { sourceKind: node.kind, sourceId: node.entityId, targetKind: target?.kind ?? null, targetId: target?.entityId ?? null }; });
  const token = crypto.randomUUID(), now = new Date().toISOString();
  const existing = await database().prepare("SELECT revision FROM approval_maps WHERE id = 'vacation'").first<{ revision: number }>();
  if (!existing && revision !== 0) throw new Error("Another administrator changed the map. Reload the saved map before saving.");
  const result = await database().batch([
    database().prepare(`INSERT INTO approval_maps (id, revision, graph_json, write_token, updated_by, updated_at) VALUES ('vacation', 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = approval_maps.revision + 1, graph_json = excluded.graph_json, write_token = excluded.write_token,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE approval_maps.revision = ?`).bind(JSON.stringify(clean), token, updatedBy, now, revision),
    database().prepare("DELETE FROM approval_routes WHERE map_id = 'vacation' AND EXISTS (SELECT 1 FROM approval_maps WHERE id = 'vacation' AND write_token = ?)").bind(token),
    database().prepare(`INSERT INTO approval_routes (map_id, source_kind, source_id, target_kind, target_id)
      SELECT 'vacation', json_extract(value, '$.sourceKind'), json_extract(value, '$.sourceId'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId')
      FROM json_each(?) WHERE EXISTS (SELECT 1 FROM approval_maps WHERE id = 'vacation' AND write_token = ?)`).bind(JSON.stringify(routes), token),
  ]);
  if (!result[0].meta.changes) throw new Error("Another administrator changed the map. Reload the saved map before saving.");
  return { revision: revision + 1, graph: clean, updatedAt: now };
}
