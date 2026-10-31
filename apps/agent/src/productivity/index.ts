import type { Database } from "../db/database.ts";
import { NoteRepository } from "./notes.ts";
import { ProjectRepository } from "./projects.ts";
import { StorageGuard } from "./storage.ts";
import { TaskRepository } from "./tasks.ts";
import { Trash } from "./trash.ts";

/** Tasks, notes, projects and their trash, over the owner's database. */
export class Productivity {
  readonly storage: StorageGuard;
  readonly trash: Trash;
  readonly tasks: TaskRepository;
  readonly notes: NoteRepository;
  readonly projects: ProjectRepository;

  constructor(db: Database, options: { timeZone: () => string; clock?: () => number }) {
    const clock = options.clock ?? Date.now;
    this.storage = new StorageGuard(db);
    this.trash = new Trash(db, this.storage, clock);
    const deps = { db, storage: this.storage, trash: this.trash, timeZone: options.timeZone, clock };
    this.tasks = new TaskRepository(deps);
    this.notes = new NoteRepository(deps);
    this.projects = new ProjectRepository(deps);
  }
}
