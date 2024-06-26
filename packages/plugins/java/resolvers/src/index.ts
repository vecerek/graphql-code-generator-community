import { dirname, normalize } from 'path';
import { GraphQLSchema } from 'graphql';
import { buildPackageNameFromPath } from '@graphql-codegen/java-common';
import {
  getCachedDocumentNodeFromSchema,
  oldVisit,
  PluginFunction,
  Types,
} from '@graphql-codegen/plugin-helpers';
import { JavaResolversPluginRawConfig } from './config.js';
import { JavaResolversVisitor } from './visitor.js';

export const plugin: PluginFunction<JavaResolversPluginRawConfig> = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config: JavaResolversPluginRawConfig,
  { outputFile },
): Promise<string> => {
  const relevantPath = dirname(normalize(outputFile));
  const defaultPackageName = buildPackageNameFromPath(relevantPath);
  const visitor = new JavaResolversVisitor(config, schema, defaultPackageName);
  const astNode = getCachedDocumentNodeFromSchema(schema);
  const visitorResult = oldVisit(astNode, { leave: visitor });
  const mappersImports = visitor.getImports();
  const packageName = visitor.getPackageName();
  const blockContent = visitorResult.definitions.filter(d => typeof d === 'string').join('\n');
  const wrappedContent = visitor.wrapWithClass(blockContent);

  return [packageName, mappersImports, wrappedContent].join('\n');
};
