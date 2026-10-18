# Sphinx Remote Literal Include for VS Code

Adds a **Preview remote include** CodeLens above Sphinx `.. rli:: URL` and `.. remoteliteralinclude:: URL` directives in reStructuredText files. The preview fetches the remote source and displays its lines with source line numbers; `:emphasize-lines:` entries are highlighted.

## Usage

Open a `.rst` file containing a remote include and select **Preview remote include** above the directive. You can also run **Sphinx Remote Literal Include: Preview Remote Include** from the Command Palette while the cursor is on or below a directive.

The preview honors the common selection options `:lines:`, `:start-at:`, `:start-after:`, `:end-at:`, `:end-before:`, `:lineno-start:`, `:lineno-match:`, `:dedent:`, and `:tab-width:`. It uses the HTTP(S) URL directly, as the Sphinx extension does. Unsupported presentation options (such as `:pyobject:` and `:diff:`) are not evaluated by this editor preview.

Set `sphinxRemoteLiteralInclude.requestTimeout` to change the remote request timeout (milliseconds).

## Development

Run `npm install`, then `npm run compile`. Press F5 in this folder to launch the Extension Development Host.

To build an installable VS Code package, run `npm run package`. This creates a `.vsix` file in the project root.
