import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'

function existingStandardFontDirFromPackage(): string | null {
    try {
        const requireFromHere = createRequire(import.meta.url)
        const pdfjsDistRoot = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'))
        const dir = path.join(pdfjsDistRoot, 'standard_fonts')
        return fs.existsSync(dir) ? dir + path.sep : null
    } catch {
        return null
    }
}

function existingStandardFontDirFromCwd(): string {
    return path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep
}

export const PDFJS_STANDARD_FONT_DATA_URL = existingStandardFontDirFromPackage() ?? existingStandardFontDirFromCwd()
