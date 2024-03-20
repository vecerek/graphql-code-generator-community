import autoBind from 'auto-bind';
import { type GraphQLSchema, type OperationDefinitionNode, print } from 'graphql';
import {
  type ClientSideBasePluginConfig,
  ClientSideBaseVisitor,
  DocumentMode,
  LoadedFragment,
  type RawClientSideBasePluginConfig,
} from '@graphql-codegen/visitor-plugin-common';

export interface EffectPluginConfig extends ClientSideBasePluginConfig {}

const clientCode = `export type GraphQLSuccessResponse<A = any> = Pick<
  Http.response.ClientResponse,
  'status' | 'headers'
> & {
  readonly body: ExecutionResult & { readonly data: A };
};

export type GraphQLErrorResponse = Pick<Http.response.ClientResponse, 'status' | 'headers'> & {
  readonly body: Pick<ExecutionResult, 'errors' | 'extensions'>;
};

export class MissingDataGraphQLResponseError extends Data.TaggedError(
  'MissingDataGraphQLResponseError',
)<GraphQLErrorResponse> {}

const headers = {
  // https://github.com/graphql/graphql-over-http/blob/main/spec/GraphQLOverHTTP.md#legacy-watershed
  Accept: 'application/graphql-response+json; charset=utf-8, application/json; charset=utf-8',
  'Content-Type': 'application/json',
};

export class GraphQLClient extends Context.Tag('GraphQLClient')<
  GraphQLClient,
  Http.client.Client<
    never,
    Http.error.HttpClientError | MissingDataGraphQLResponseError,
    GraphQLSuccessResponse
  >
>() {
  static fromDefaultClient(client: Http.client.Client.Default): Layer.Layer<GraphQLClient> {
    return Layer.succeed(
      GraphQLClient,
      client.pipe(
        Http.client.mapRequest(Http.request.setHeaders(headers)),
        Http.client.filterStatusOk,
        Http.client.mapEffectScoped(res =>
          Effect.flatMap(res.json, _ => {
            const body = _ as ExecutionResult;
            return body.data
              ? Effect.succeed({ ...res, body: { ...body, data: body.data } })
              : Effect.fail(new MissingDataGraphQLResponseError({ ...res, body }));
          }),
        ),
      ),
    );
  }

  static Live: Layer.Layer<GraphQLClient, never, Http.client.Client.Default> = Layer.unwrapEffect(
    Effect.map(Http.client.Client, GraphQLClient.fromDefaultClient),
  );

  static fromEndpoint(
    endpoint: string,
  ): Layer.Layer<GraphQLClient, never, Http.client.Client.Default> {
    return Layer.unwrapEffect(
      Effect.map(Http.client.Client, client =>
        GraphQLClient.fromDefaultClient(
          Http.client.mapRequest(client, Http.request.prependUrl(endpoint)),
        ),
      ),
    );
  }
}`;

const additionalStaticContent = (documentMode: DocumentMode) => `
export type GraphQLOperationOptions = {
  preferredOpName?: string;
};

type GraphQLOperationArgs = {
  document: ${documentMode === DocumentMode.string ? 'string' : 'DocumentNode'};
  fallbackOperationName: string;
};

${clientCode}

const makeGraphQLOperation =
  <Vars, Data>({ document, fallbackOperationName }: GraphQLOperationArgs) =>
  (variables: Vars, opts?: GraphQLOperationOptions) => {
    const operationName = opts?.preferredOpName ?? fallbackOperationName;
    const query = ${documentMode === DocumentMode.string ? 'document' : 'print(document)'};

    return Effect.flatMap(GraphQLClient, client =>
      Http.request.post('').pipe(
        Http.request.jsonBody({
          query,
          operationName,
          variables,
        }),
        Effect.flatMap(client),
        Effect.map(_ => _ as GraphQLSuccessResponse<Data>),
      ),
    );
  };
`;

export class EffectVisitor extends ClientSideBaseVisitor<
  RawClientSideBasePluginConfig,
  EffectPluginConfig
> {
  private _externalImportPrefix: string;
  private _operationsToInclude: {
    node: OperationDefinitionNode;
    documentVariableName: string;
    operationType: string;
    operationResultType: string;
    operationVariablesTypes: string;
  }[] = [];

  constructor(
    schema: GraphQLSchema,
    fragments: LoadedFragment[],
    rawConfig: RawClientSideBasePluginConfig,
  ) {
    super(schema, fragments, rawConfig, {});

    autoBind(this);

    type ImportType = 'type' | 'value';
    type Import = [name: string, type: ImportType];
    const createNamedImport = (imports: Import[], from: string) => {
      const normalizedImports = imports.map(([name, type]) =>
        this.config.useTypeImports && type === 'type' ? `type ${name}` : name,
      );

      return `import { ${normalizedImports.join(', ')} } from '${from}';`;
    };
    const createNamesaceImport = (namespace: string, from: string, type: ImportType = 'value') =>
      `import ${type === 'type' ? 'type ' : ''}* as ${namespace} from '${from}';`;

    [
      createNamedImport(
        [
          ['Context', 'value'],
          ['Data', 'value'],
          ['Effect', 'value'],
          ['Layer', 'value'],
        ],
        'effect',
      ),
      createNamedImport(
        [
          ['DocumentNode', 'type'],
          ['ExecutionResult', 'type'],
          ['print', 'value'],
        ],
        'graphql',
      ),
      createNamesaceImport('Http', '@effect/platform/HttpClient'),
    ].forEach(_ => this._additionalImports.push(_));

    this._externalImportPrefix = this.config.importOperationTypesFrom
      ? `${this.config.importOperationTypesFrom}.`
      : '';
  }

  public OperationDefinition(node: OperationDefinitionNode) {
    const operationName = node.name?.value;

    if (!operationName) {
      // eslint-disable-next-line no-console
      console.warn(
        `Anonymous GraphQL operation was ignored in "typescript-effect", please make sure to name your operation: `,
        print(node),
      );

      return null;
    }

    return super.OperationDefinition(node);
  }

  protected buildOperation(
    node: OperationDefinitionNode,
    documentVariableName: string,
    operationType: string,
    operationResultType: string,
    operationVariablesTypes: string,
  ): string {
    operationResultType = this._externalImportPrefix + operationResultType;
    operationVariablesTypes = this._externalImportPrefix + operationVariablesTypes;

    this._operationsToInclude.push({
      node,
      documentVariableName,
      operationType,
      operationResultType,
      operationVariablesTypes,
    });

    return null;
  }

  private getDocumentNodeVariable(documentVariableName: string): string {
    return this.config.documentMode === DocumentMode.external
      ? `Operations.${documentVariableName}`
      : documentVariableName;
  }

  public get sdkContent(): string {
    const allPossibleOperations = this._operationsToInclude.map(
      ({ node, documentVariableName, operationResultType, operationVariablesTypes }) => {
        const operationName = node.name.value;
        const docVarName = this.getDocumentNodeVariable(documentVariableName);
        return `export const ${operationName} = makeGraphQLOperation<${operationVariablesTypes}, ${operationResultType}>({
  document: ${docVarName},
  fallbackOperationName: '${operationName}',
});`;
      },
    );

    return `${additionalStaticContent(this.config.documentMode)}\n${allPossibleOperations.join(
      '\n',
    )}\n`;
  }
}
