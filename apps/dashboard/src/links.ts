/** Follows a same-origin link without a reload; a modified click opens it the browser's way. */
export function linkHandler(navigate: (path: string) => void, path: string) {
  return (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };
}
