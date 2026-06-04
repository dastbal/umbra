import { Tool } from "@langchain/core/tools";
import { 
  safeWriteFileTool, 
  safeReadFileTool, 
  askCodebaseTool, 
  integrityCheckTool, 
  refreshIndexTool, 
  executeTestsTool, 
  listFilesTool, 
  executeCommandTool, 
  askHumanTool, 
  deleteFileTool 
} from ".";
import * as fs from "fs";
import * as path from "path";
import { IndexerService } from "../rag/indexer";
import { RetrieverService } from "../rag/retriever";
import { ToolMessage } from "@langchain/core/messages";

// Mock child_process
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  exec: (command: string, options: any, callback: any) => {
    mockExec(command, options).then(
      (result: any) => callback(null, result),
      (err: any) => callback(err)
    );
  }
}));

// Mock FS
jest.mock("fs");
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock RAG Services
jest.mock("../rag/indexer", () => ({
  IndexerService: jest.fn().mockImplementation(() => ({
    indexProject: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock("../rag/retriever", () => ({
  RetrieverService: jest.fn().mockImplementation(() => ({
    getContextForLLM: jest.fn().mockResolvedValue("Mocked context"),
  })),
}));

describe("Tools Unit Tests", () => {
  const rootDir = path.resolve(process.cwd(), "mock-proj");

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process, "cwd").mockReturnValue(rootDir);
  });

  describe("safeWriteFileTool", () => {
    it("should return metadata on successful write", async () => {
      const filePath = "test.ts";
      const fullPath = path.resolve(rootDir, filePath);
      
      mockFs.existsSync.mockImplementation((p) => {
        if (p === fullPath) return true; // File exists
        return true; // Directory exists
      });

      const res = await safeWriteFileTool.invoke({ file_path: filePath, content: "data" });
      expect(res).toContain('METADATA: {"path": "test.ts", "action": "modified"}');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(fullPath, "data", "utf-8");
    });

    it("should return 'created' metadata if file didn't exist", async () => {
      const filePath = "new.ts";
      const fullPath = path.resolve(rootDir, filePath);

      mockFs.existsSync.mockImplementation((p) => {
        if (p === fullPath) return false; // File missing
        return true; // Directory exists
      });

      const res = await safeWriteFileTool.invoke({ file_path: filePath, content: "data" });
      expect(res).toContain('METADATA: {"path": "new.ts", "action": "created"}');
    });

    it("should block writes outside root", async () => {
      const res = await safeWriteFileTool.invoke({ file_path: "../outside.ts", content: "data" });
      expect(res).toContain("Access denied");
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("deleteFileTool", () => {
    it("should delete existing file", async () => {
      mockFs.existsSync.mockReturnValue(true);
      const res = await deleteFileTool.invoke({ file_path: "temp.ts" });
      expect(res).toContain("✅ SUCCESS: File temp.ts has been deleted.");
      expect(mockFs.unlinkSync).toHaveBeenCalled();
    });

    it("should return error if file missing", async () => {
      mockFs.existsSync.mockReturnValue(false);
      const res = await deleteFileTool.invoke({ file_path: "missing.ts" });
      expect(res).toContain("❌ ERROR: File missing.ts does not exist.");
    });
  });

  describe("executeCommandTool", () => {
    it("should block dangerous patterns", async () => {
      const res = await executeCommandTool.invoke({ command: "rm -rf /" });
      expect(res).toContain("Command blocked for security reasons.");
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should execute safe commands", async () => {
      mockExec.mockResolvedValue({ stdout: "ok", stderr: "" });
      const res = await executeCommandTool.invoke({ command: "ls" });
      expect(res).toContain("✅ SUCCESS");
      expect(mockExec).toHaveBeenCalled();
    });
  });

  describe("executeTestsTool", () => {
    it("should run all tests if no path provided", async () => {
      mockExec.mockResolvedValue({ stdout: "passed", stderr: "" });
      const res = await executeTestsTool.invoke({});
      expect(mockExec).toHaveBeenCalledWith("npm test", expect.any(Object));
      expect(res).toContain("✅ SUCCESS");
    });

    it("should run specific test if path provided", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockExec.mockResolvedValue({ stdout: "passed", stderr: "" });
      const res = await executeTestsTool.invoke({ filePath: "src/test.spec.ts" });
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("jest src/test.spec.ts"), expect.any(Object));
    });
  });

  describe("askCodebaseTool", () => {
    it("should use RetrieverService", async () => {
      const res = await askCodebaseTool.invoke({ query: "what is X" });
      expect(res).toBe("Mocked context");
    });
  });

  describe("integrityCheckTool", () => {
    it("should run tsc --noEmit", async () => {
      mockExec.mockResolvedValue({ stdout: "all good", stderr: "" });
      const res = await integrityCheckTool.invoke({});
      expect(mockExec).toHaveBeenCalledWith("npx tsc --noEmit", expect.any(Object));
      expect(res).toContain("PASSED");
    });
  });
});
