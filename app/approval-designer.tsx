"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ApprovalGraph, ApprovalMapDocument, ApprovalNode } from "../lib/approval-map-types";

type Person = { id: number; full_name: string; role: string; status: string; has_portal_access: number; department_id: number | null };
type Team = { id: number; name: string; manager_user_id: number | null; active: number };
type Props = { people: Person[]; departments: Team[]; document: ApprovalMapDocument;
  onSave: (graph: ApprovalGraph, revision: number) => Promise<void>;
  notify: (message: string, tone?: "success" | "error") => void };
const boxWidth = 236;
const eligible = (person: Person | undefined) => Boolean(person && ["manager", "admin"].includes(person.role) && ["active", "on_leave"].includes(person.status) && person.has_portal_access);

export default function ApprovalDesigner({ people, departments, document, onSave, notify }: Props) {
  const [graph, setGraph] = useState<ApprovalGraph>(() => structuredClone(document.graph));
  const [selected, setSelected] = useState<string | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  const [palette, setPalette] = useState<"department" | "person">("department");
  const [search, setSearch] = useState("");
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(25);
  const [expanded, setExpanded] = useState(false);
  const [panning, setPanning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const canvasPanel = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 0, y: 0 });
  const pan = useRef<{ pointer: number; x: number; y: number; viewX: number; viewY: number } | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const previous = globalThis.document.body.style.overflow;
    globalThis.document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", escape);
    return () => { globalThis.document.body.style.overflow = previous; window.removeEventListener("keydown", escape); };
  }, [expanded]);
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; nodeX: number; nodeY: number } | null>(null);
  const dirty = JSON.stringify(graph) !== JSON.stringify(document.graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const personIds = new Set(graph.nodes.filter((node) => node.kind === "person").map((node) => node.entityId));
  const name = (node: ApprovalNode) => node.kind === "department" ? departments.find((team) => team.id === node.entityId)?.name ?? `Department #${node.entityId}` : people.find((person) => person.id === node.entityId)?.full_name ?? `Employee #${node.entityId} (unavailable)`;
  const approver = (node: ApprovalNode) => node.kind === "person" ? people.find((person) => person.id === node.entityId) : people.find((person) => person.id === departments.find((team) => team.id === node.entityId)?.manager_user_id);
  const coveredPeople = (node: ApprovalNode) => node.kind === "person" ? people.filter((person) => person.id === node.entityId) : people.filter((person) => person.department_id === node.entityId && ["active", "on_leave"].includes(person.status) && !personIds.has(person.id));
  const selectedNode = nodes.get(selected ?? "");
  const selectedEdge = graph.edges.find((edge) => edge.from === selected);
  const selectedTarget = nodes.get(selectedEdge?.to ?? "");
  const targetApprover = selectedTarget ? approver(selectedTarget) : undefined;
  const selectedMembers = selectedNode ? coveredPeople(selectedNode) : [];
  const query = search.trim().toLowerCase();
  const choices = (palette === "department" ? departments.map((team) => ({ id: team.id, label: team.name, detail: team.active ? "Department" : "Inactive department" })) : people.map((person) => ({ id: person.id, label: person.full_name, detail: departments.find((team) => team.id === person.department_id)?.name ?? "No department" })))
    .filter((item) => !query || `${item.label} ${item.detail}`.toLowerCase().includes(query));
  const width = Math.max(1050, ...graph.nodes.map((node) => node.x + boxWidth + 60));
  const height = Math.max(650, ...graph.nodes.map((node) => node.y + 220));

  function add(kind: ApprovalNode["kind"], entityId: number) {
    const id = `${kind}:${entityId}`;
    if (nodes.has(id)) { setSelected(id); return; }
    if (graph.nodes.length >= 500) { notify("The map supports up to 500 boxes.", "error"); return; }
    const column = kind === "department" ? 40 : 430;
    const last = graph.nodes.filter((node) => Math.abs(node.x - column) < boxWidth);
    const y = last.length ? Math.max(...last.map((node) => node.y)) + 190 : 40;
    setGraph((current) => ({ ...current, nodes: [...current.nodes, { id, kind, entityId, x: column, y }] }));
    setSelected(id);
  }
  function move(id: string, x: number, y: number) {
    setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, x: Math.min(100000, Math.max(0, Math.round(x))), y: Math.min(100000, Math.max(0, Math.round(y))) } : node) }));
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, node: ApprovalNode) {
    if (event.button !== 0) return;
    setSelected(node.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: node.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
  }
  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    move(current.id, current.nodeX + (event.clientX - current.x) / zoom, current.nodeY + (event.clientY - current.y) / zoom);
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest(".approval-node, button, input, select, a, [role=button]")) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, viewX: view.current.x, viewY: view.current.y };
    setPanning(true);
  }
  function continuePan(event: PointerEvent<HTMLDivElement>) {
    const current = pan.current;
    if (!current || current.pointer !== event.pointerId) return;
    moveView(current.viewX + event.clientX - current.x, current.viewY + event.clientY - current.y);
  }
  function moveView(x: number, y: number) {
    view.current = { x, y };
    viewport.current?.style.setProperty("--approval-pan-x", `${x}px`);
    viewport.current?.style.setProperty("--approval-pan-y", `${y}px`);
  }
  function resetView() { moveView(0, 0); setZoom(1); }
  function changeZoom(next: number) {
    const centerX = (viewport.current?.clientWidth ?? 0) / 2, centerY = (viewport.current?.clientHeight ?? 0) / 2;
    moveView(centerX - (centerX - view.current.x) * next / zoom, centerY - (centerY - view.current.y) * next / zoom);
    setZoom(next);
  }
  function keyboardPan(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [50, 0], ArrowRight: [-50, 0], ArrowUp: [0, 50], ArrowDown: [0, -50] };
    if (offsets[event.key]) { event.preventDefault(); const [x, y] = offsets[event.key]; moveView(view.current.x + x, view.current.y + y); }
    if (event.key === "Home") { event.preventDefault(); resetView(); }
  }
  function endPan() { pan.current = null; setPanning(false); }
  function containFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!expanded || event.key !== "Tab") return;
    const controls = Array.from(canvasPanel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select, [tabindex='0']") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  function connect(to: string) {
    if (!connection) return;
    const from = nodes.get(connection), target = nodes.get(to);
    if (!from || !target || from.id === target.id) { notify("Choose a different box as the approver.", "error"); return; }
    const assigned = approver(target);
    if (!eligible(assigned)) { notify("The approver needs active Manager or Administrator access. A department uses its assigned manager.", "error"); return; }
    if (from.kind === "person" && assigned?.id === from.entityId) { notify("Employees cannot approve their own vacation.", "error"); return; }
    const edges = [...graph.edges.filter((edge) => edge.from !== from.id), { from: from.id, to }];
    let current: string | undefined = to;
    const seen = new Set<string>([from.id]);
    while (current) { if (seen.has(current)) { notify("This line would create a circular chain.", "error"); return; } seen.add(current); current = edges.find((edge) => edge.from === current)?.to; }
    setGraph((value) => ({ ...value, edges })); setConnection(null); setSelected(from.id);
  }
  function removeBox() {
    if (!selectedNode) return;
    const id = selectedNode.id;
    setGraph((value) => ({ nodes: value.nodes.filter((node) => node.id !== id), edges: value.edges.filter((edge) => edge.from !== id && edge.to !== id) }));
    setSelected(null); setConnection(null);
  }
  async function save() {
    setBusy(true);
    try { await onSave(graph, document.revision); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to save the map. Your edits are still here.", "error"); }
    finally { setBusy(false); }
  }

  return <section className="content-section approval-designer">
    <div className="section-heading compact"><div><p className="eyebrow">Administration</p><h1>Approval process</h1><p>Connect a department or person to whoever approves their vacation.</p></div><button className="button button-primary" disabled={busy || (!dirty && document.revision > 0)} aria-busy={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save approval process"}</button></div>
    <div className="approval-map-rules"><strong>One person, one route.</strong><span>A separate person box takes priority over their department. Each box has one outgoing approval line. Unconnected boxes go to HR.</span><small>Lines set the initial decision. An approver’s own line controls their own requests; it does not add another approval to their team’s requests.</small></div>
    <div className="approval-designer-layout">
      <aside className="approval-palette panel"><h2>Add boxes</h2><div className="filter-tabs"><button className={palette === "department" ? "active" : ""} onClick={() => { setPalette("department"); setSearch(""); setLimit(25); }}>Departments</button><button className={palette === "person" ? "active" : ""} onClick={() => { setPalette("person"); setSearch(""); setLimit(25); }}>People</button></div><label>Search<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(25); }} placeholder={palette === "department" ? "Department name…" : "Any employee name…"} /></label><div className="approval-palette-list">{choices.slice(0, limit).map((item) => <button key={item.id} className={nodes.has(`${palette}:${item.id}`) ? "already-added" : ""} onClick={() => add(palette, item.id)}><span><strong>{item.label}</strong><small>{item.detail}</small></span><span>{nodes.has(`${palette}:${item.id}`) ? "View" : "Add"}</span></button>)}{!choices.length && <p>No matches.</p>}</div>{choices.length > limit && <button className="text-button" onClick={() => setLimit(limit + 25)}>Show more</button>}<p className="form-footnote">Any employee can be a requester. An approver needs Manager or Administrator access.</p></aside>
      <div ref={canvasPanel} className={`approval-canvas-panel panel ${expanded ? "approval-canvas-expanded" : ""}`} role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label="Approval map" onKeyDown={containFocus}><div className="approval-canvas-toolbar"><span role="status">{document.revision === 0 ? "Current department setup · save to activate" : dirty ? "Unsaved changes" : `Saved revision ${document.revision}`}</span><button className="button button-secondary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Minimize canvas" : "Expand canvas"}</button>{expanded && <button className="button button-primary" disabled={busy || (!dirty && document.revision > 0)} onClick={() => void save()}>{busy ? "Saving…" : "Save process"}</button>}<label>Zoom<select value={zoom} onChange={(event) => changeZoom(Number(event.target.value))}>{[.25, .5, .75, 1, 1.25].map((value) => <option key={value} value={value}>{value * 100}%</option>)}</select></label><button className="text-button" onClick={resetView}>Reset view</button><button className="text-button" onClick={() => { setGraph(structuredClone(document.graph)); setSelected(null); setConnection(null); }}>Reset edits</button></div><p className="approval-canvas-help">Click and drag empty white space to move around the map. Drag a box header to reposition it. Use Connect to choose an approver.</p>{connection && <div className="approval-connect-banner" role="status"><span>Choose the approver for <strong>{name(nodes.get(connection)!)}</strong>.</span><button className="text-button" onClick={() => setConnection(null)}>Cancel connection</button></div>}
        <div ref={viewport} className={`approval-canvas-scroll ${panning ? "panning" : ""}`} tabIndex={0} aria-label="Approval map canvas. Drag empty space freely in any direction. Arrow keys pan. Home resets the view." onKeyDown={keyboardPan} onPointerDown={startPan} onPointerMove={continuePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}><div className="approval-canvas-size" style={{ width: 0, height: 0 }}><div className="approval-canvas" style={{ width, height, transform: `translate(var(--approval-pan-x, 0px), var(--approval-pan-y, 0px)) scale(${zoom})` }}>
          <svg className="approval-lines" width={width} height={height} aria-label="Approval connections"><defs><marker id="approval-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="currentColor" /></marker></defs>{graph.edges.map((edge) => {
            const from = nodes.get(edge.from), to = nodes.get(edge.to); if (!from || !to) return null;
            const right = to.x >= from.x, x1 = from.x + (right ? boxWidth : 0), x2 = to.x + (right ? 0 : boxWidth), y1 = from.y + 58, y2 = to.y + 58;
            const bend = Math.max(75, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
            const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
            return <g key={edge.from}><path className={`approval-line ${selected === edge.from ? "selected" : ""}`} d={path} markerEnd="url(#approval-arrow)" /><path className="approval-line-hit" d={path} role="button" tabIndex={0} aria-label={`${name(from)} approved by ${name(to)}. Select connection.`} onClick={() => setSelected(edge.from)} onKeyDown={(event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); setSelected(edge.from); } }} /></g>;
          })}</svg>
          {graph.nodes.map((node) => {
            const outgoing = graph.edges.find((edge) => edge.from === node.id), target = nodes.get(outgoing?.to ?? "");
            const memberCount = coveredPeople(node).length, isTarget = eligible(approver(node));
            return <article key={node.id} className={`approval-node ${node.kind} ${selected === node.id ? "selected" : ""} ${connection && isTarget && connection !== node.id ? "connect-target" : ""}`} style={{ left: node.x, top: node.y, width: boxWidth }}>
              <button className="approval-node-handle" title={name(node)} aria-label={`${name(node)}. Select or drag this box; arrow keys move it.`} onPointerDown={(event) => startDrag(event, node)} onPointerMove={continueDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onClick={() => setSelected(node.id)} onKeyDown={(event) => { const offsets: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }; if (offsets[event.key]) { event.preventDefault(); const [x, y] = offsets[event.key]; move(node.id, node.x + x, node.y + y); } }}><small>{node.kind === "department" ? `${memberCount} people · department` : "Individual override"}</small><strong>{name(node)}</strong></button>
              <div className="approval-node-route" title={target ? `Approver: ${name(target)}` : "HR fallback"}>{target ? name(target) : "HR fallback"}</div><div className="approval-node-actions">{connection ? <button disabled={!isTarget || connection === node.id} onClick={() => connect(node.id)}>Approves this box</button> : <button onClick={() => { setConnection(node.id); setSelected(node.id); }}>Connect</button>}<button onClick={() => setSelected(node.id)}>Details</button></div>
            </article>;
          })}
          {!graph.nodes.length && <p className="approval-empty-canvas">Add a department or person to start the map.</p>}
        </div></div></div>
      </div>
    </div>
    <div className="approval-map-bottom"><article className="panel approval-selection"><p className="eyebrow">Selected box</p>{selectedNode ? <><h2>{name(selectedNode)}</h2><p>Initial approver: <strong>{eligible(targetApprover) && !(selectedNode.kind === "person" && targetApprover?.id === selectedNode.entityId) ? targetApprover?.full_name : "HR fallback"}</strong></p><p>{selectedNode.kind === "department" ? `${selectedMembers.length} active/on-leave employees covered. Individual boxes are excluded.` : "This employee follows this box instead of their department’s route."}</p><div className="approval-selection-actions"><button className="button button-secondary" onClick={() => setConnection(selectedNode.id)}>{selectedEdge ? "Change approver" : "Connect approver"}</button>{selectedEdge && <button className="text-button" onClick={() => { setGraph((value) => ({ ...value, edges: value.edges.filter((edge) => edge.from !== selectedNode.id) })); setConnection(null); }}>Remove line</button>}<button className="text-button danger-text" onClick={removeBox}>Remove box</button></div>{selectedMembers.length > 0 && <details><summary>Employees covered ({selectedMembers.length})</summary><ul>{selectedMembers.map((person) => <li key={person.id}>{person.full_name}{person.id === targetApprover?.id ? " · HR reviews their own requests" : ""}</li>)}</ul></details>}</> : <p>Select a box or line to review or change its assignment.</p>}</article><article className="panel approval-built-in"><p className="eyebrow">Connected vacation processes</p><h2>After the mapped decision</h2><div><strong>Hourly</strong><span>Mapped approver → Payroll record → HR sign-off</span></div><div><strong>Salaried</strong><span>Mapped approver → HR sign-off</span></div><p>Approval immediately updates employee history, the calendar and salaried balances. Processing stays on that same request. Save to apply the map to pending and new requests.</p><small>Departments without a box use their assigned department manager. An unavailable approver or a self-approval routes to HR.</small></article></div>
  </section>;
}
