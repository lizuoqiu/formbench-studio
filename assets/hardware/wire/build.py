"""Independent seven-strand 22 AWG reference. Curved route and exposed lengths are illustrative."""
import numpy as np, trimesh as tm
from pathlib import Path
root=Path(__file__).parent

def tube(points,r,n):
    points=np.array(points);t=np.gradient(points,axis=0);t/=np.linalg.norm(t,axis=1)[:,None];b=np.cross([0,0,1],t);b/=np.linalg.norm(b,axis=1)[:,None];h=np.cross(t,b);a=np.arange(n)*2*np.pi/n;v=(points[:,None,:]+r*(b[:,None,:]*np.cos(a)[None,:,None]+h[:,None,:]*np.sin(a)[None,:,None])).reshape(-1,3);f=[]
    for i in range(len(points)-1):
        for j in range(n):
            x=i*n+j;y=i*n+(j+1)%n;f.extend([(x,y,y+n),(x,y+n,x+n)])
    for j in range(1,n-1): f.extend([(0,j+1,j),((len(points)-1)*n,(len(points)-1)*n+j,(len(points)-1)*n+j+1)])
    m=tm.Trimesh(v,f);m.invert() if m.volume<0 else None;return m

def route(x):return np.stack((x,4*(1-np.cos(x*np.pi/48)),0*x),axis=1)
def main():
    jacket=tube(route(np.linspace(4,44,81)),.8,32);copper=[]
    for j in range(7):
        for lo,hi in [(0,4),(44,48)]:
            x=np.linspace(lo,hi,25);p=route(x);phi=j*np.pi/3+1.05*x;dr=.245 if j<6 else 0;p[:,1]+=dr*np.cos(phi);p[:,2]+=dr*np.sin(phi);copper.append(tube(p,.122,12))
    for fname,m in [('insulation',jacket),('copper',tm.util.concatenate(copper))]:
        assert m.is_watertight and m.volume>0;m.export(root/(fname+'.stl'))
if __name__=='__main__':main()
