const { AngularWebpackPlugin } = require('@ngtools/webpack');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const fs = require('fs');
const path = require('path');

// Angular's npm packages ship partially compiled; the linker finishes them at
// build time so the bundle needs no runtime JIT compiler.
const angularLinker = require('@angular/compiler-cli/linker/babel');

const modPrefixes = fs.readdirSync('assets')
    .filter(f => f.endsWith('.aircraft.json'))
    .map(f => f.slice(0, -'.aircraft.json'.length));

function isModAsset(resourcePath) {
    const base = path.basename(resourcePath);
    return modPrefixes.some(p =>
        base === `${p}.aircraft.json` || base.startsWith(`${p}_`));
}

/**
 * The baked terrain tree is a build product, not a tracked asset.
 *
 * In development it is served straight from the repo by tools/modserver.ts, so
 * a build does not spend time copying ~82 MB it did not change. A production
 * build does copy it, because dist/ has to be deployable on its own — anything
 * serving dist/ with a plain static server would otherwise 404 the manifest.
 */
module.exports = (_env, argv) => ({
    // ui.css is the settings dialog's Material theme and Tailwind utilities,
    // extracted next to the bundle as bundle.css.
    entry: ['./src/script/index.ts', './src/ui.css'],
    devtool: 'inline-source-map',
    output: {
        path: __dirname + '/dist',
        filename: 'bundle.js'
    },
    module: {
        rules: [
            {
                // Every .ts file goes through the Angular compiler, not only the
                // settings dialog: it owns the whole TypeScript program, and for
                // plain modules its output is ordinary tsc output.
                test: /\.ts$/,
                loader: '@ngtools/webpack',
                exclude: /node_modules/,
            },
            {
                test: /\.[cm]?js$/,
                include: /node_modules[\\/]@angular[\\/]/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        babelrc: false,
                        configFile: false,
                        compact: false,
                        cacheDirectory: true,
                        plugins: [angularLinker.default ?? angularLinker],
                    },
                },
            },
            {
                test: /\.css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    'css-loader',
                    {
                        loader: 'postcss-loader',
                        options: { postcssOptions: { plugins: ['@tailwindcss/postcss'] } },
                    },
                ],
            },
            {
                // @0x62/jsbsim-wasm ships its Emscripten glue module and the wasm
                // binary and references them via `new URL(..., import.meta.url)`
                // (see its dist/wasm.js). Treat both as raw, uncompiled assets so
                // webpack copies them to the output and rewrites the URLs, instead
                // of trying to parse the Emscripten glue as a normal JS module.
                test: /\.(wasm|mjs)$/,
                type: 'asset/resource',
                include: path.resolve(__dirname, 'node_modules/@0x62/jsbsim-wasm'),
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    // tsconfig includes all of src/, so the Angular compiler notices every
    // module nothing imports yet (the mission editor, debug helpers).
    ignoreWarnings: [/is part of the TypeScript compilation but it's unused/],
    plugins: [
        new AngularWebpackPlugin({
            tsconfig: path.resolve(__dirname, 'tsconfig.json'),
            jitMode: false,
        }),
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
        new CopyPlugin({
            patterns: [
                {
                    from: 'src/index.html',
                    to: 'index.html',
                    transform(content) {
                        const v = Date.now();
                        return content.toString()
                            .replace('src="./bundle.js"', `src="./bundle.js?v=${v}"`)
                            .replace('href="./bundle.css"', `href="./bundle.css?v=${v}"`);
                    },
                },
                {
                    from: 'src/style.css',
                    to: 'style.css',
                },
                {
                    from: 'assets/*',
                    to: 'assets/[name][ext]',
                    filter: (resourcePath) => !isModAsset(resourcePath),
                },
                {
                    // Bundled JSBSim aircraft/engine/systems data (see assets/jsbsim/),
                    // fetched at runtime by the JSBSim worker. Copied as a whole
                    // directory tree so the JSBSim-native folder layout survives.
                    from: 'assets/jsbsim',
                    to: 'assets/jsbsim',
                },
                // Development serves assets/terrain from the repo; only a
                // production build copies it into dist/ (see the note above).
                ...(argv && argv.mode === 'production'
                    ? [{ from: 'assets/terrain', to: 'assets/terrain', noErrorOnMissing: true }]
                    : []),
            ]
        })
    ]
});
