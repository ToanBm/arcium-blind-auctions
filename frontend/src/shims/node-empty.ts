// Empty shim for Node.js built-in modules that are not available in the browser
export default {};
export const readFileSync = () => "";
export const writeFileSync = () => {};
export const existsSync = () => false;
