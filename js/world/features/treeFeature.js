export class TreeFeature {
  constructor(params) {
      this.type = 'tree';
      this.subtype = params.subtype || 'OAK';
      this.variant = params.variant || 0;
      this.position = params.position;
      this.rotation = { x: 0, y: params.rotation || 0, z: 0 };
      this.scale = { x: params.scale || 1, y: params.scale || 1, z: params.scale || 1 };
      this.shapeSeed = params.shapeSeed;
      
      this.isStatic = true;
      this.isProp = true;
      this.isInstanced = true;
      
      // For compatibility
      this.parameters = { variant: this.variant };
  }
  
  getType() { return this.type; }
  getShapeSeed() { return this.shapeSeed; }
  getGlobalId() { return `tree_${this.subtype}_${this.variant}_${this.shapeSeed}`; }
}