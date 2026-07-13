export interface DesktopPathCheckInput {
  label: string;
  path: string | null | undefined;
}

export interface DesktopPathIssue {
  label: string;
  path: string;
  character: string;
  codePoint: number;
}

export function findFirstNonAsciiCharacter(value: string): {
  character: string;
  codePoint: number;
} | null {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x7f) {
      return { character, codePoint };
    }
  }

  return null;
}

export function findFirstNonAsciiPath(
  paths: readonly DesktopPathCheckInput[],
): DesktopPathIssue | null {
  for (const item of paths) {
    if (!item.path) {
      continue;
    }

    const match = findFirstNonAsciiCharacter(item.path);
    if (match) {
      return {
        label: item.label,
        path: item.path,
        character: match.character,
        codePoint: match.codePoint,
      };
    }
  }

  return null;
}

export function formatNonAsciiPathMessage(issue: DesktopPathIssue): string {
  const hexCodePoint = `U+${issue.codePoint.toString(16).toUpperCase()}`;

  return [
    "Claw-Pi cannot start from a path that contains non-ASCII characters.",
    "",
    `Problem path (${issue.label}):`,
    issue.path,
    "",
    `Unsupported character: ${issue.character} (${hexCodePoint})`,
    "",
    "Please move or install Claw-Pi to a short English path, for example:",
    "C:\\ClawPi",
    "D:\\ClawPi",
    "",
    "If your Windows user folder contains non-ASCII characters, use an ASCII-only Windows account or a custom ASCII data directory.",
  ].join("\n");
}
