import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const generatedImageUrlPattern =
  /(^|[\s>])(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif))(?=$|[\s<])/giu;

function isAllowedChatImageUrl(src: string): boolean {
  try {
    const url = new URL(src);
    const isLocalHost =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLocalHost &&
      /^\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif)$/iu.test(
        url.pathname,
      )
    );
  } catch {
    return /^\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif)$/iu.test(
      src,
    );
  }
}

function embedGeneratedImageLinks(content: string): string {
  return content.replace(generatedImageUrlPattern, (_match, prefix, url) => {
    return `${prefix}![生成图片](${url})`;
  });
}

// Open links in new tab with safe rel attributes
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer nofollow");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token?.attrGet("src") ?? "";
  if (!isAllowedChatImageUrl(src)) {
    return md.utils.escapeHtml(src);
  }

  const alt = md.utils.escapeHtml(token?.content ?? "生成图片");
  const escapedSrc = md.utils.escapeHtml(src);
  return `<img src="${escapedSrc}" alt="${alt}" loading="lazy" decoding="async" />`;
};

export function renderMarkdown(content: string): string {
  return md.render(embedGeneratedImageLinks(content));
}
