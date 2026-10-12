'use strict';

const { buildFormatOptions } = require('../configuration');

/** @param {{vscode: object, loadNativeModule: () => object|null, reportNativeMissing: () => void}} deps @returns {{formatDocument: (document: object, range?: object) => Promise<string|null>}} */
function createFormatter({ vscode, loadNativeModule, reportNativeMissing }) {
    /**
     * Format Verilog/SystemVerilog code using native module
     */
    async function formatDocument(document, range = null) {
        const native = loadNativeModule();
        if (!native) {
            reportNativeMissing();
            return null;
        }

        const config = vscode.workspace.getConfiguration('svtools');

        // Get the document text
        const text = document.getText(range);

        const options = buildFormatOptions(config);

        try {
            const formattedText = native.formatText(text, options);
            return formattedText;
        } catch (error) {
            vscode.window.showErrorMessage(`Formatting failed: ${error.message}`);
            console.error('Formatting error:', error);
            return null;
        }
    }
    return { formatDocument };
}

module.exports = { createFormatter };
