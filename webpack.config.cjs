const path = require("node:path");
const webpack = require("webpack");
const packageJson = require("./package.json");

module.exports = {
  entry: {},
  mode: "production",
  output: {
    path: path.resolve(__dirname, "public"),
    filename: "[name].js",
    chunkFilename: "config-[contenthash].js",
    clean: false,
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [["@babel/preset-react", { runtime: "automatic" }]],
          },
        },
      },
    ],
  },
  resolve: { extensions: [".jsx", ".js"] },
  plugins: [
    new webpack.container.ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, "_"),
      library: {
        type: "var",
        name: packageJson.name.replace(/[-@/]/g, "_"),
      },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
        "react-dom": { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
