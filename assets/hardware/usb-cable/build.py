"""Original illustrative cable; units mm. Run with numpy, trimesh and manifold3d."""
from pathlib import Path
import numpy as np, trimesh as tm
out=Path(__file__).parent

def loft(rings):
    n=len(rings[0]); verts=np.array(rings).reshape((-1,3)); faces=[]
    for i in range(len(rings)-1):
        for j in range(n):
            a=i*n+j;b=i*n+(j+1)%n;faces.extend([(a,b,b+n),(a,b+n,a+n)])
    for start,sgn in [(0,-1),((len(rings)-1)*n,1)]:
        for j in range(1,n-1):
            f=(start,start+j,start+j+1);faces.append(f if sgn>0 else f[::-1])
    m=tm.Trimesh(verts,faces);m.invert() if m.volume < 0 else None;return m

def plug(xlayers,y0=0, micro=False):
    rings=[]
    for x,w,h in xlayers:
        w/=2;h/=2
        if micro: points=[(-w+.22,-h),(w-.22,-h),(w,-h+.20),(w,h*.10),(w-.6,h),(-w+.6,h),(-w,h*.1),(-w,-h+.20)]
        else:
            r=min(.7,h*.22);points=[(-w+r,-h),(w-r,-h),(w,-h+r),(w,h-r),(w-r,h),(-w+r,h),(-w,h-r),(-w,-h+r)]
        rings.append([(x,y+y0,z) for y,z in points]);
    return loft(rings)

def tube(pts,rs,n=20):
    pts=np.array(pts); tangent=np.gradient(pts,axis=0);tangent/=np.linalg.norm(tangent,axis=1)[:,None]; perp=np.stack([-tangent[:,1],tangent[:,0],np.zeros(len(pts))],1); theta=np.linspace(0,2*np.pi,n,endpoint=False);return loft(pts[:,None,:]+np.array(rs).reshape(-1,1,1)*(perp[:,None,:]*np.cos(theta)[None,:,None]+np.array([0,0,1])[None,None,:]*np.sin(theta)[None,:,None]))

def block(x,y,z,size):return tm.creation.box(extents=size,transform=tm.transformations.translation_matrix((x,y,z)))
def minus(a,*bs):return tm.boolean.difference([a,*bs],engine='manifold')
def save(name,mesh):
    if isinstance(mesh,list):mesh=tm.util.concatenate(mesh)
    assert mesh.is_watertight and mesh.volume>0,(name,mesh.volume);mesh.export(out/(name+'.stl'))

def main():
    # Two parallel connectors face left. Micro-B tip at origin, A tip offset y=-36.
    y=-36.;a=plug([(0,12,4.5),(12,12,4.5)],y);a=minus(a,plug([(-1,11.4,3.9),(11.8,11.4,3.9)],y),*[block(5.6,y+off,2.2,[2.2,1.5,1]) for off in [-2.5,2.5]])
    b=minus(plug([(0,6.85,1.8),(5.6,6.85,1.8)],micro=True),plug([(-.3,6.35,1.28),(5.3,6.35,1.28)],micro=True))
    save('shells',[a,b]);save('insulators',[block(6.2,y,-.74,[10.8,10.2,1.12]),plug([(1.0,5.5,.48),(5.55,5.5,.48)],micro=True)]);save('contacts',[block(5.6,y+j,.01,[7.8,.85,.16]) for j in [-3.5,-1,1,3.5]]+[block(2.9,j,.27,[3.55,.31,.08]) for j in [-1.3,-.65,0,.65,1.3]])
    grips=[plug([(12,14.2,6.1),(13.5,15.5,7.8),(28,15.5,7.8),(31,10,6)],y),plug([(5.6,8.6,4.0),(7,10,5.5),(19,10,5.5),(23,7.2,4.4)])]
    for x0,yy,r0,xe in [(31,y,2.95,41),(23,0,2.15,32)]:
        xs=np.linspace(x0,xe,80);r=1.55+(r0-1.55)*(xe-xs)/(xe-x0)-.17*np.maximum(0,np.cos((xs-x0)*3.7));grips.append(tube([(x,yy,0) for x in xs],r,24))
    save('overmoulds',grips)
    xturn=55.;ang=np.linspace(-np.pi/2,np.pi/2,76);pts=[(x,y,0) for x in np.linspace(41,xturn,12)]+[(xturn+18*np.cos(t),-18+18*np.sin(t),0) for t in ang[1:-1]]+[(x,0,0) for x in np.linspace(xturn,32,14)];save('jacket',tube(pts,[1.55]*len(pts),24))
if __name__=='__main__':main()
