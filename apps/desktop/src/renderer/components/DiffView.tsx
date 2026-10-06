import { useMemo } from "react";
import { type DiffFile, parsePatch } from "../ui.js";
import { Icon } from "./Icon.js";

const FILE_STATUS: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
};

export function DiffView({ files, patch }: { files: DiffFile[]; patch: string }) {
  const parsed = useMemo(() => parsePatch(patch), [patch]);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  if (files.length === 0) {
    return (
      <div className="empty-inline">
        <Icon name="file" size={20} />
        <p>No changes yet. Files the agent edits will show up here.</p>
      </div>
    );
  }

  return (
    <div className="diff">
      <div className="diff-summary">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="add-count">+{additions}</span>
        <span className="del-count">−{deletions}</span>
      </div>
      {files.map((file) => {
        const lines = parsed.get(file.path) ?? [];
        return (
          <section className="diff-file" key={file.path}>
            <header className="diff-file-header">
              <span className={`file-badge file-${file.status}`} title={FILE_STATUS[file.status]}>
                {file.status}
              </span>
              <span className="mono diff-path">{file.path}</span>
              <span className="add-count">+{file.additions}</span>
              <span className="del-count">−{file.deletions}</span>
            </header>
            {lines.length === 0 ? (
              <p className="diff-note">No text changes to show.</p>
            ) : (
              <table className="diff-table">
                <tbody>
                  {lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and never reorder
                    <tr key={index} className={`diff-line diff-${line.kind}`}>
                      <td className="gutter">{line.kind === "hunk" ? "" : (line.oldLine ?? "")}</td>
                      <td className="gutter">{line.kind === "hunk" ? "" : (line.newLine ?? "")}</td>
                      <td className="sign">
                        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                      </td>
                      <td className="code">{line.text || " "}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
