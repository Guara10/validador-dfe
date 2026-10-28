import dictJson from '../generated/nfe-dict.json';
import schemasJson from '../generated/nfe-schemas.json';
import { Dict, type DNode } from './dict';

export const nfeDict = new Dict(dictJson as unknown as DNode);
export const nfeSchemas = schemasJson as { entry: Record<string, string>; files: Record<string, string> };
