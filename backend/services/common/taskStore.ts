import { getMongoDb, isMongoEnabled } from "./mongo";
import { newId, readDb, writeDb } from "./jsonStore";

export type TaskRecord = {
  id: string;
  leadId?: string;
  assignedTo?: string;
  kind: string;
  title: string;
  description?: string;
  source?: string;
  status: "open" | "done" | "dismissed";
  priority: number;
  dueAt?: string | null;
  createdAt: string;
  updatedAt: string;
  meta?: Record<string, unknown> | null;
};

function fromTaskDoc(doc: any): TaskRecord | null {
  if (!doc) return null;
  const task = { ...doc };
  if (!task.id) task.id = String(task._id);
  delete task._id;
  return task as TaskRecord;
}

function toTaskDoc(task: TaskRecord) {
  return { ...task, _id: task.id };
}

export async function listTasks(query: { status?: string; leadId?: string; includeDismissed?: boolean } = {}) {
  if (!isMongoEnabled()) {
    let rows = readDb().tasks || [];
    if (query.status) rows = rows.filter((task: TaskRecord) => task.status === query.status);
    else if (!query.includeDismissed) rows = rows.filter((task: TaskRecord) => task.status !== "dismissed");
    if (query.leadId) rows = rows.filter((task: TaskRecord) => task.leadId === query.leadId);
    return rows.sort((a: TaskRecord, b: TaskRecord) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return new Date(a.dueAt || a.createdAt).getTime() - new Date(b.dueAt || b.createdAt).getTime();
    });
  }
  const db = await getMongoDb();
  const filter: any = {};
  if (query.status) filter.status = query.status;
  else if (!query.includeDismissed) filter.status = { $ne: "dismissed" };
  if (query.leadId) filter.leadId = query.leadId;
  const docs = await db.collection("tasks").find(filter).sort({ priority: -1, dueAt: 1, createdAt: -1 }).toArray();
  return docs.map((doc) => fromTaskDoc(doc)).filter(Boolean) as TaskRecord[];
}

export async function getTaskById(taskId: string) {
  if (!isMongoEnabled()) return (readDb().tasks || []).find((task: TaskRecord) => task.id === taskId) || null;
  const db = await getMongoDb();
  const doc = await db.collection("tasks").findOne({ _id: taskId });
  return fromTaskDoc(doc);
}

export async function saveTask(task: TaskRecord) {
  if (!isMongoEnabled()) {
    const db = readDb();
    const tasks = Array.isArray(db.tasks) ? db.tasks : [];
    const idx = tasks.findIndex((item: TaskRecord) => item.id === task.id);
    if (idx >= 0) tasks[idx] = task;
    else tasks.push(task);
    db.tasks = tasks;
    writeDb(db);
    return task;
  }
  const db = await getMongoDb();
  await db.collection("tasks").replaceOne({ _id: task.id }, toTaskDoc(task), { upsert: true });
  return task;
}

export async function createTask(input: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: newId("task"),
    createdAt: now,
    updatedAt: now,
    ...input
  };
  return saveTask(task);
}

export async function findOpenTaskByLeadAndKind(leadId: string, kind: string) {
  if (!leadId || !kind) return null;
  if (!isMongoEnabled()) {
    const tasks = readDb().tasks || [];
    return tasks.find((task: TaskRecord) => task.leadId === leadId && task.kind === kind && task.status === "open") || null;
  }
  const db = await getMongoDb();
  const doc = await db.collection("tasks").findOne({ leadId, kind, status: "open" });
  return fromTaskDoc(doc);
}

export async function listTasksByLeadAndKind(leadId: string, kind: string) {
  if (!leadId || !kind) return [];
  if (!isMongoEnabled()) {
    const tasks = readDb().tasks || [];
    return tasks
      .filter((task: TaskRecord) => task.leadId === leadId && task.kind === kind)
      .sort((a: TaskRecord, b: TaskRecord) => {
        const aTime = new Date(a.updatedAt || a.createdAt).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt).getTime();
        return bTime - aTime;
      });
  }
  const db = await getMongoDb();
  const docs = await db.collection("tasks").find({ leadId, kind }).sort({ updatedAt: -1, createdAt: -1 }).toArray();
  return docs.map((doc) => fromTaskDoc(doc)).filter(Boolean) as TaskRecord[];
}

export async function findRecentManualDuplicate(input: {
  leadId?: string;
  kind: string;
  title: string;
  dueAt?: string | null;
  assignedTo?: string;
  windowMs?: number;
  exactDueAt?: boolean;
}) {
  const windowMs = input.windowMs ?? 10 * 60 * 1000;
  const now = Date.now();
  const normalizedTitle = String(input.title || "").trim().toLocaleLowerCase("it");
  const normalizedAssignedTo = String(input.assignedTo || "").trim().toLocaleLowerCase("it");
  const normalizedDueAt = input.dueAt ? new Date(input.dueAt).toISOString() : "";
  const candidates = input.leadId ? await listTasks({ leadId: input.leadId, includeDismissed: true }) : await listTasks({ includeDismissed: true });

  return (
    candidates.find((task) => {
      const createdAt = new Date(task.createdAt || task.updatedAt).getTime();
      if (!Number.isFinite(createdAt) || now - createdAt > windowMs) return false;
      if (task.status !== "open") return false;
      if ((task.source || "").toLocaleLowerCase("it") === "automation" || (task.source || "").toLocaleLowerCase("it") === "scheduler") {
        return false;
      }
      if (String(task.kind || "").toLocaleLowerCase("it") !== String(input.kind || "").toLocaleLowerCase("it")) return false;
      if (String(task.title || "").trim().toLocaleLowerCase("it") !== normalizedTitle) return false;
      if (String(task.assignedTo || "").trim().toLocaleLowerCase("it") !== normalizedAssignedTo) return false;
      if (input.exactDueAt !== false) {
        const taskDueAt = task.dueAt ? new Date(task.dueAt).toISOString() : "";
        if (taskDueAt !== normalizedDueAt) return false;
      }
      return true;
    }) || null
  );
}
