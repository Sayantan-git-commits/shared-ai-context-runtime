import type {
  Project,
  Task,
  Checkpoint,
  CreateCheckpointInput,
  AssembleContextResponse,
  AssembleContextRequest,
} from "@ctx/schemas";

export class CtxApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = "http://127.0.0.1:3000") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  public async resolveProject(projectName?: string, gitRemoteUrl?: string): Promise<Project> {
    const res = await fetch(`${this.baseUrl}/v1/projects/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectName, gitRemoteUrl }),
    });
    if (!res.ok) {
      throw new Error(`Failed to resolve project: ${res.statusText}`);
    }
    return (await res.json()) as Project;
  }

  public async getProject(projectId: string): Promise<Project> {
    const res = await fetch(`${this.baseUrl}/v1/projects/${projectId}`);
    if (!res.ok) {
      throw new Error(`Failed to get project ${projectId}: ${res.statusText}`);
    }
    return (await res.json()) as Project;
  }

  public async getLatestCheckpoint(projectId: string): Promise<Checkpoint | null> {
    const res = await fetch(`${this.baseUrl}/v1/projects/${projectId}/checkpoints/latest`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to get checkpoint: ${res.statusText}`);
    }
    return (await res.json()) as Checkpoint;
  }

  public async listCheckpoints(projectId: string): Promise<Checkpoint[]> {
    const res = await fetch(`${this.baseUrl}/v1/projects/${projectId}/checkpoints`);
    if (!res.ok) {
      throw new Error(`Failed to list checkpoints: ${res.statusText}`);
    }
    return (await res.json()) as Checkpoint[];
  }

  public async createCheckpoint(
    projectId: string,
    input: Omit<CreateCheckpointInput, "projectId">
  ): Promise<Checkpoint> {
    const res = await fetch(`${this.baseUrl}/v1/projects/${projectId}/checkpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, projectId }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create checkpoint: ${res.statusText}`);
    }
    return (await res.json()) as Checkpoint;
  }

  public async getTask(taskId: string): Promise<Task | null> {
    const res = await fetch(`${this.baseUrl}/v1/tasks/${taskId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to get task: ${res.statusText}`);
    return (await res.json()) as Task;
  }

  public async assembleContext(
    projectId: string,
    req: AssembleContextRequest
  ): Promise<AssembleContextResponse> {
    const res = await fetch(`${this.baseUrl}/v1/projects/${projectId}/context/assemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`Failed to assemble context: ${res.statusText}`);
    }
    return (await res.json()) as AssembleContextResponse;
  }

  public async listEvents(projectId: string): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/v1/projects/${projectId}/events`);
    if (!res.ok) {
      throw new Error(`Failed to list events: ${res.statusText}`);
    }
    return (await res.json()) as any[];
  }

  public async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
