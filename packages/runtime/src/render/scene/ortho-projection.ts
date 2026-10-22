// K16: orthographic world camera (`templates/camera.js` `projection: "orthographic"`, `state.orthoSize`; engine `cameras.md`).
//
// The world camera stays ONE `PerspectiveCamera` object for the whole session (the scene, the renderer, the light grid, the
// viewmodel and the HUD all hold it), so "orthographic" is a projection mode of that object, not a second camera: while the
// mode is on, the camera's `updateProjectionMatrix` builds an orthographic matrix with half-height `orthoSize` and half-width
// `orthoSize x aspect`, and `Vector3.project` / three's culling and view-space depth keep working unchanged. Switching back
// restores three's own method. Perspective stays the default and is byte-for-byte the legacy host's path (this file is not touched then).
//
// The dynamic-light grid tells the two projections apart by the matrix's last row (lighting/dynamic-lights.ts `isOrthographic`) and culls
// against the box, so clustered lights are right in both modes.
import type { PerspectiveCamera, CoordinateSystem } from 'three/webgpu';

export type ProjectionMode = 'perspective' | 'orthographic';

export interface ProjectionSwitch {
  readonly mode: ProjectionMode;
  /** half-height in metres while orthographic, else null */
  readonly orthoSize: number | null;
  /**
   * Sets the mode from a pose's fields (`projection` absent = perspective). Returns whether the projection changed and the
   * caller must call `updateProjectionMatrix()`. Throws RangeError for a non-finite or non-positive `orthoSize`.
   */
  set(projection: ProjectionMode | undefined, orthoSize: number | undefined): boolean;
}

/** The orthographic frustum of half-height `size` at `aspect` (half-width = size x aspect). */
export function orthoExtents(size: number, aspect: number): { left: number; right: number; top: number; bottom: number } {
  const hw = size * aspect;
  return { left: -hw, right: hw, top: size, bottom: -size };
}

export function createProjectionSwitch(camera: PerspectiveCamera, coordinateSystem: () => CoordinateSystem): ProjectionSwitch {
  const perspective = camera.updateProjectionMatrix.bind(camera);
  let mode: ProjectionMode = 'perspective';
  let size = 0;

  const ortho = (): void => {
    const e = orthoExtents(size, camera.aspect);
    camera.projectionMatrix.makeOrthographic(e.left, e.right, e.top, e.bottom, camera.near, camera.far, coordinateSystem());
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };

  return {
    get mode(): ProjectionMode {
      return mode;
    },
    get orthoSize(): number | null {
      return mode === 'orthographic' ? size : null;
    },
    set(projection, orthoSize) {
      if (projection === 'orthographic') {
        if (typeof orthoSize !== 'number' || !Number.isFinite(orthoSize) || orthoSize <= 0) {
          throw new RangeError(`camera presenter: an orthographic pose needs a finite orthoSize > 0, got ${String(orthoSize)}`);
        }
        const changed = mode !== 'orthographic' || size !== orthoSize;
        mode = 'orthographic';
        size = orthoSize;
        if (changed) camera.updateProjectionMatrix = ortho;
        return changed;
      }
      if (mode === 'perspective') return false;
      mode = 'perspective';
      camera.updateProjectionMatrix = perspective;
      return true;
    },
  };
}
