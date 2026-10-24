'use strict';

const { buildFormatOptions } = require('../configuration');
const { preservesCharacters } = require('./format-safety');

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

        try {
            const config = vscode.workspace.getConfiguration('svtools');
            const text = document.getText(range);
            const options = buildFormatOptions(config);
            const formattedText = native.formatText(text, options);
            if (!preservesCharacters(text, formattedText)) {
                console.warn('Formatting changed non-layout characters; original text preserved.');
                return text;
            }
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
