export function getOpenAIModelsResponse(models, ownedBy, metadataMap = {}) {
  return {
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: ownedBy,
      ...(metadataMap[id] || {})
    }))
  };
}

export function getOpenAIModelResponse(id, ownedBy, metadataMap = {}) {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: ownedBy,
    ...(metadataMap[id] || {})
  };
}
