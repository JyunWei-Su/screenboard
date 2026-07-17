// Allow importing the install script as raw text (wrangler Text module rule).
declare module "*.sh" {
  const content: string;
  export default content;
}
