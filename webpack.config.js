const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const { renderHelp } = require('./config/help-pages.js');
module.exports = (_, argv) => ({
  mode: argv.mode || 'production',
  entry: { background: './src/background.js', pdf_open: './src/pdf_open.js', viewer: './src/viewer.js',
    popup: './src/popup.js', settings: './src/settings_ui.js', offscreen: './src/browser_ai/host.js' },
  output: { path: path.resolve(__dirname, 'build'), filename: '[name].js', clean: true },
  module: { rules: [{ test: /node_modules[\\/]@wllama[\\/]wllama[\\/]esm[\\/]index\.js$/, use: require.resolve('./config/wllama-static-loader.js') }] },
  plugins: [new CopyPlugin({ patterns: [{ from: 'public', globOptions: { ignore: ['**/*.map'] } },
    { from: 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm', to: 'browser-ai/wllama.wasm' },
    { from: 'doc/beta-smoke.pdf', to: 'example.pdf' },
    { from: 'README.md', to: 'help.html', transform: renderHelp },
    { from: 'doc/*.md', to: 'help/[name].html', transform: renderHelp },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'help/notices.html', transform: renderHelp },
    { from: 'LICENSE', to: 'LICENSE', toType: 'file' }, { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }] })],
  devtool: argv.mode === 'development' ? 'source-map' : false,
  stats: 'errors-warnings',
});
