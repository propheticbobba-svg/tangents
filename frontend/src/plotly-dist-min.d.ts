declare module "plotly.js-dist-min" {
  type Root = HTMLElement;
  const Plotly: {
    react(
      root: Root,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>,
    ): Promise<unknown>;
    purge(root: Root): void;
    Plots: { resize(root: Root): unknown };
  };
  export default Plotly;
}
